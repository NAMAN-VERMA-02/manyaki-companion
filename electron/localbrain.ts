// Manyaki's offline brain. Runs in an Electron utility process (separate from the UI) so heavy model
// work never stalls her animation. Everything here runs on this PC; nothing is sent anywhere except the
// one-time model downloads from Hugging Face.
//
//   think      Qwen2.5-3B-Instruct (GGUF, llama.cpp; Vulkan on the iGPU when available)
//   hear       Whisper small (ONNX, multilingual — handles Hindi/Hinglish)
//   speak      Kokoro-82M (ONNX, English voices)
//   feel       a GoEmotions classifier (28 emotions, trained on 58k human-labelled sentences)

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

type In =
  | { id: number; type: 'status' }
  | { id: number; type: 'download' }
  | { id: number; type: 'warm'; system?: string }
  | { id: number; type: 'chat'; system: string; history: { role: 'user' | 'her'; text: string }[]; text: string; teach?: boolean }
  | { id: number; type: 'transcribe'; audio: Float32Array }
  | { id: number; type: 'tts'; text: string; voice: string }
  | { id: number; type: 'emotion'; texts: string[] }

export interface LocalStatus {
  llm: 'missing' | 'downloading' | 'ready' | 'loaded'
  asr: 'missing' | 'downloading' | 'ready' | 'loaded'
  tts: 'missing' | 'downloading' | 'ready' | 'loaded'
  progress: number // overall download progress 0..1 while downloading
  gpu: string
  error: string
}

// Runs as a normal child process (ELECTRON_RUN_AS_NODE) talking over Node IPC. Electron's utility process
// was ~5x slower here: Windows throttles it like a background service.
const port = {
  on: (_e: 'message', cb: (m: { data: In }) => void) => process.on('message', (m) => cb({ data: m as In })),
  postMessage: (m: unknown) => process.send?.(m)
}
const MODELS_DIR = process.env.MANYAKI_MODELS_DIR ?? join(process.cwd(), 'models')
const HF_DIR = join(MODELS_DIR, 'hf')
const LLM_URI = 'hf:Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M'
const ASR_ID = 'onnx-community/whisper-small'
const TTS_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
mkdirSync(HF_DIR, { recursive: true })

const status: LocalStatus = { llm: 'missing', asr: 'missing', tts: 'missing', progress: 0, gpu: '', error: '' }
const send = (m: unknown) => port.postMessage(m)
const pushStatus = () => send({ type: 'status', status })

// ---------- model presence ----------

function llmFile(): string | null {
  if (!existsSync(MODELS_DIR)) return null
  const f = readdirSync(MODELS_DIR).find((n) => /qwen2\.5-3b.*\.gguf$/i.test(n))
  return f ? join(MODELS_DIR, f) : null
}

/** transformers.js caches as <cache>/<org>/<model>/...; treat a model as present if its onnx files exist. */
function hfPresent(id: string): boolean {
  const dir = join(HF_DIR, ...id.split('/'))
  if (!existsSync(dir)) return false
  const walk = (d: string): boolean => readdirSync(d).some((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p) : n.endsWith('.onnx') && statSync(p).size > 1e6
  })
  return walk(dir)
}

function refreshPresence() {
  if (status.llm !== 'loaded' && status.llm !== 'downloading') status.llm = llmFile() ? 'ready' : 'missing'
  if (status.asr !== 'loaded' && status.asr !== 'downloading') status.asr = hfPresent(ASR_ID) ? 'ready' : 'missing'
  if (status.tts !== 'loaded' && status.tts !== 'downloading') status.tts = hfPresent(TTS_ID) ? 'ready' : 'missing'
}

// ---------- lazy model loading ----------

type Transformers = typeof import('@huggingface/transformers')
let tf: Transformers | null = null
async function transformers(allowRemote: boolean): Promise<Transformers> {
  if (!tf) tf = await import('@huggingface/transformers')
  tf.env.cacheDir = HF_DIR
  tf.env.allowLocalModels = true
  tf.env.allowRemoteModels = allowRemote
  return tf
}

let llamaP: Promise<{ model: import('node-llama-cpp').LlamaModel; llama: import('node-llama-cpp').Llama }> | null = null
function loadLlm() {
  if (!llamaP) {
    llamaP = (async () => {
      const file = llmFile()
      if (!file) throw new Error('local brain model not downloaded')
      const { getLlama } = await import('node-llama-cpp')
      // CPU is faster than Vulkan on Intel iGPUs for this model size (measured: 8 s vs 40 s load, quicker tokens).
      const llama = await getLlama({ gpu: false })
      status.gpu = String(llama.gpu || 'cpu')
      const model = await llama.loadModel({ modelPath: file })
      status.llm = 'loaded'
      pushStatus()
      return { model, llama }
    })().catch((e) => { llamaP = null; throw e })
  }
  return llamaP
}

let ctxP: Promise<import('node-llama-cpp').LlamaContext> | null = null
async function context() {
  if (!ctxP) ctxP = loadLlm().then(({ model }) => model.createContext({ contextSize: 4096 }))
  return ctxP
}

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>
let asrP: Promise<Asr> | null = null
function loadAsr() {
  if (!asrP) {
    asrP = (async () => {
      const t = await transformers(false)
      const p = await t.pipeline('automatic-speech-recognition', ASR_ID, { dtype: 'q8', device: 'cpu' })
      status.asr = 'loaded'
      pushStatus()
      return p as unknown as Asr
    })().catch((e) => { asrP = null; throw e })
  }
  return asrP
}

let ttsP: Promise<import('kokoro-js').KokoroTTS> | null = null
function loadTts() {
  if (!ttsP) {
    ttsP = (async () => {
      await transformers(false)
      const { KokoroTTS } = await import('kokoro-js')
      const tts = await KokoroTTS.from_pretrained(TTS_ID, { dtype: 'q8', device: 'cpu' })
      status.tts = 'loaded'
      pushStatus()
      return tts
    })().catch((e) => { ttsP = null; throw e })
  }
  return ttsP
}

// ---------- download ----------

let downloading: Promise<void> | null = null
function download(): Promise<void> {
  if (downloading) return downloading
  downloading = (async () => {
    status.error = ''
    // Rough weights so the overall bar moves sensibly: LLM ~2.1 GB, Whisper ~0.3 GB, Kokoro ~0.1 GB.
    const parts = { llm: 0, asr: 0, tts: 0 }
    const update = () => {
      status.progress = parts.llm * 0.84 + parts.asr * 0.12 + parts.tts * 0.04
      pushStatus()
    }
    if (!llmFile()) {
      status.llm = 'downloading'
      const { createModelDownloader } = await import('node-llama-cpp')
      const d = await createModelDownloader({
        modelUri: LLM_URI,
        dirPath: MODELS_DIR,
        onProgress: ({ downloadedSize, totalSize }) => { parts.llm = totalSize ? downloadedSize / totalSize : 0; update() }
      })
      await d.download()
    }
    parts.llm = 1
    status.llm = 'ready'
    update()
    const t = await transformers(true)
    const progress = (key: 'asr' | 'tts') => (p: { status: string; progress?: number }) => {
      if (p.status === 'progress' && p.progress != null) { parts[key] = Math.min(0.99, p.progress / 100); update() }
    }
    if (!hfPresent(ASR_ID)) {
      status.asr = 'downloading'
      await t.pipeline('automatic-speech-recognition', ASR_ID, { dtype: 'q8', device: 'cpu', progress_callback: progress('asr') })
    }
    parts.asr = 1
    status.asr = 'ready'
    update()
    if (!hfPresent(TTS_ID)) {
      status.tts = 'downloading'
      const { KokoroTTS } = await import('kokoro-js')
      await KokoroTTS.from_pretrained(TTS_ID, { dtype: 'q8', device: 'cpu', progress_callback: progress('tts') as never })
    }
    parts.tts = 1
    status.tts = 'ready'
    status.progress = 1
    await transformers(false)
    pushStatus()
  })().catch((e: Error) => {
    status.error = e.message
    refreshPresence()
    pushStatus()
    throw e
  }).finally(() => { downloading = null })
  return downloading
}

// ---------- chat ----------
//
// Speed matters on a laptop CPU: reading a long prompt is the slowest part, so one chat session is kept
// alive and her (static) persona is read once. Each turn only adds a tiny context line plus your words.
// She replies in plain short text; moods and actions are decided by deterministic rules on the app side
// (faster, and immune to prompt injection since the model can't trigger actions by itself).

const LOCAL_RULES = `
You are running fully offline on their PC. Reply with ONLY the words you say out loud: one or two short, warm
sentences in the same language they used (English, Hindi or Hinglish). No lists, no emojis, no actions in brackets.
If they ask you to open something or start a timer, just say a quick cute line like "Okay, opening it~" — the app does it.
If they ask you to explain or teach something, give a simple clear explanation in small steps and check if it made sense.`

let session: { key: string; s: import('node-llama-cpp').LlamaChatSession; seq: import('node-llama-cpp').LlamaContextSequence } | null = null

async function getSession(system: string) {
  if (session && session.key === system) return session.s
  const ctx = await context()
  const { LlamaChatSession } = await import('node-llama-cpp')
  session?.seq.dispose()
  const seq = ctx.getSequence()
  const s = new LlamaChatSession({ contextSequence: seq, systemPrompt: system + '\n' + LOCAL_RULES })
  session = { key: system, s, seq }
  return s
}

/** Reads the persona once ahead of time so the first offline reply only has to process your message. */
async function preparePersona(system: string) {
  const s = await getSession(system)
  if (s.getChatHistory().length <= 1) await s.preloadPrompt('')
}

async function chat(system: string, _history: { role: 'user' | 'her'; text: string }[], text: string, teach = false) {
  let s = await getSession(system)
  // Keep the context small: start fresh (persona re-read once) when the conversation grows long.
  if (session && session.seq.nextTokenIndex > 3000) {
    session.seq.dispose()
    session = null
    s = await getSession(system)
  }
  const t0 = Date.now()
  // Teaching gets room for a real explanation (still short enough to listen to comfortably).
  const prompt = teach ? `${text}\n(Teach it: explain simply in 3-5 short sentences with one tiny example, then ask if it made sense.)` : text
  const raw = await s.prompt(prompt, { maxTokens: teach ? 220 : 70, temperature: teach ? 0.6 : 0.8, topP: 0.9, repeatPenalty: { penalty: 1.1 } })
  const say = raw.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\*[^*]{1,30}\*/g, '').replace(/\s+/g, ' ').trim()
  return { say, ms: Date.now() - t0 }
}

// ---------- feel: a trained emotion classifier ----------
//
// Small and quick on CPU (tens of ms per sentence). Downloaded on first use (≈67 MB), then offline.
// The first model that loads wins; if none does, the app falls back to its word lists.

const EMO_IDS = ['Cohee/distilbert-base-uncased-go-emotions-onnx', 'SamLowe/roberta-base-go_emotions-onnx']
type Classifier = (t: string[], o: Record<string, unknown>) => Promise<{ label: string; score: number }[][] | { label: string; score: number }[]>
let emoP: Promise<Classifier> | null = null
let emoFailedAt = 0
function loadEmotion() {
  if (!emoP) {
    emoP = (async () => {
      const t = await transformers(true)
      let last: unknown
      for (const id of EMO_IDS) {
        for (const dtype of ['q8', 'fp32'] as const) {
          try {
            const p = await t.pipeline('text-classification', id, { dtype, device: 'cpu' })
            return p as unknown as Classifier
          } catch (e) { last = e }
        }
      }
      throw last instanceof Error ? last : new Error('no emotion model could be loaded')
    })().catch((e) => { emoP = null; emoFailedAt = Date.now(); throw e })
  }
  return emoP
}

async function emotions(texts: string[]) {
  // After a failed download, don't retry for 10 minutes (offline, or Hugging Face unreachable).
  if (!emoP && Date.now() - emoFailedAt < 10 * 60000) return null
  const clf = await loadEmotion()
  const t0 = Date.now()
  const raw = await clf(texts.map((x) => x.slice(0, 400)), { top_k: 28 })
  // One text gives a flat list; several give one list each.
  const lists = (texts.length === 1 && raw.length && !Array.isArray(raw[0]) ? [raw] : raw) as { label: string; score: number }[][]
  return { scores: lists.map((l) => Object.fromEntries(l.map((x) => [x.label, x.score]))), ms: Date.now() - t0 }
}

// ---------- hear / speak ----------

async function transcribe(audio: Float32Array) {
  const asr = await loadAsr()
  const t0 = Date.now()
  const out = await asr(audio, { task: 'transcribe', chunk_length_s: 30, return_timestamps: false })
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim()
  return { text, ms: Date.now() - t0 }
}

async function speak(text: string, voice: string) {
  const tts = await loadTts()
  const t0 = Date.now()
  const audio = await tts.generate(text, { voice: (voice || 'af_heart') as 'af_heart', speed: 1.05 })
  return { samples: audio.audio as Float32Array, rate: audio.sampling_rate, ms: Date.now() - t0 }
}

// ---------- message loop ----------

port.on('message', async ({ data: msg }) => {
  try {
    let result: unknown
    switch (msg.type) {
      case 'status': refreshPresence(); result = status; break
      case 'download': await download(); refreshPresence(); result = status; break
      case 'warm': {
        refreshPresence()
        // Load what is present in the background so the first offline reply isn't slow.
        const jobs: Promise<unknown>[] = []
        if (status.llm === 'ready') jobs.push(msg.system ? preparePersona(msg.system) : context())
        if (status.asr === 'ready') jobs.push(loadAsr())
        if (status.tts === 'ready') jobs.push(loadTts())
        await Promise.allSettled(jobs)
        result = status
        break
      }
      case 'chat': result = await chat(msg.system, msg.history, msg.text, msg.teach); break
      case 'transcribe': result = await transcribe(msg.audio); break
      case 'tts': result = await speak(msg.text, msg.voice); break
      case 'emotion': result = await emotions(msg.texts).catch(() => null); break
    }
    send({ id: msg.id, ok: true, result })
  } catch (err) {
    send({ id: msg.id, ok: false, error: (err as Error).message })
  }
})

refreshPresence()
pushStatus()
