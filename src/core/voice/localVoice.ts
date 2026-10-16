import type { AudioOut } from './audioOut'

/**
 * Fallback speech when Gemini Live is unavailable: Kokoro (local neural TTS) sentence by sentence,
 * with the system's speechSynthesis as a last resort while Kokoro is still downloading.
 */
export class LocalVoice {
  private worker: Worker | null = null
  private ready = false
  progress = 0
  private nextId = 1
  private pending = new Map<number, (r: { samples: Float32Array; rate: number } | null) => void>()
  private queue: Promise<void> = Promise.resolve()
  private generation = 0
  lastMs = 0
  voice = 'af_heart'
  onProgress?: (p: number) => void
  onReady?: () => void

  constructor(private readonly out: AudioOut, private readonly log: (m: string) => void) {}

  get isReady() { return this.ready }

  /** Start downloading the model in the background. Safe to call repeatedly. */
  warmUp() {
    if (this.worker) return
    this.worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e) => {
      const m = e.data
      if (m.type === 'progress') { this.progress = m.value; this.onProgress?.(m.value) }
      else if (m.type === 'ready') { this.ready = true; this.onReady?.() }
      else if (m.type === 'audio') { this.lastMs = m.ms; this.pending.get(m.id)?.({ samples: m.samples, rate: m.rate }); this.pending.delete(m.id) }
      else if (m.type === 'error') { this.log(`kokoro: ${m.message}`); this.pending.get(m.id)?.(null); this.pending.delete(m.id) }
    }
    this.worker.onerror = (e) => this.log(`kokoro worker: ${e.message}`)
    this.worker.postMessage({ type: 'load' })
  }

  /** Speak text; sentences are synthesised ahead while earlier ones play. */
  speak(text: string) {
    const gen = this.generation
    const sentences = splitSentences(text)
    const jobs = sentences.map((s) => this.synth(s))
    this.queue = this.queue.then(async () => {
      for (let i = 0; i < jobs.length; i++) {
        const r = await jobs[i]
        if (gen !== this.generation) return
        if (r) this.out.enqueueFloat(r.samples, r.rate)
        else await this.systemSpeak(sentences[i])
      }
    })
  }

  stop() {
    this.generation++
    speechSynthesis.cancel()
    this.out.stop()
  }

  private synth(text: string): Promise<{ samples: Float32Array; rate: number } | null> {
    if (!this.ready || !this.worker) return Promise.resolve(null)
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.worker!.postMessage({ type: 'speak', id, text, voice: this.voice, speed: 1.05 })
    })
  }

  /** Windows' built-in voice: instant but robotic; lip-sync is driven by a fake envelope. */
  systemSpeaking = false
  private systemSpeak(text: string): Promise<void> {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text)
      const voices = speechSynthesis.getVoices()
      u.voice = voices.find((v) => /aria|jenny|zira|female/i.test(v.name) && /en/i.test(v.lang)) ?? voices.find((v) => /^en/i.test(v.lang)) ?? null
      u.pitch = 1.35
      u.rate = 1.05
      u.onstart = () => { this.systemSpeaking = true }
      u.onend = u.onerror = () => { this.systemSpeaking = false; resolve() }
      speechSynthesis.speak(u)
    })
  }
}

export function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?~…]+[.!?~…]+["')\]]*|[^.!?~…]+$/g) ?? []
  // Merge very short fragments ("Hehe!") into the next sentence so synthesis calls stay efficient.
  const out: string[] = []
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    if (out.length && out[out.length - 1].length < 12) out[out.length - 1] += ' ' + p
    else out.push(p)
  }
  return out
}
