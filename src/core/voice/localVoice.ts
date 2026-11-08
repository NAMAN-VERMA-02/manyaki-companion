import type { AudioOut } from './audioOut'

type Engine = 'cloud' | 'kokoro' | 'system'
const SLOW_KEY = 'manyaki.kokoroSlow'
function remembered() {
  try { return localStorage.getItem(SLOW_KEY) === '1' } catch { return false }
}

export type Synth = (text: string) => Promise<{ samples: Float32Array; rate: number; ms?: number } | null>

/**
 * Speech when Gemini Live is not speaking, sentence by sentence, best option first:
 *   1. Gemini TTS (same voice as Live) — only when online and cloud use is allowed,
 *   2. Kokoro in the local brain — only while it keeps up with real time on this PC (measured),
 *   3. Windows' built-in voice — instant, always available, and used for Hindi (Kokoro is English-only).
 */
export class LocalVoice {
  private queue: Promise<void> = Promise.resolve()
  private generation = 0
  lastMs = 0
  /** Set by the companion; returns null when cloud use isn't allowed right now. */
  cloud: Synth | null = null
  /** Local Kokoro via the offline brain process. */
  localTts: Synth | null = null
  /** Kokoro too slow on this machine (synthesis slower than playback): skip it, and remember that across runs. */
  kokoroSlow = remembered()
  private kokoroCalls = 0
  private pending = 0
  private pendingGen = 0
  /** Called when everything queued has been said and nothing is still playing. */
  onIdle: (() => void) | null = null

  /** Something queued hasn't been said yet, even if no audio happens to be playing between two sentences. */
  get busy() { return this.pending > 0 && this.pendingGen === this.generation }

  constructor(private readonly out: AudioOut, private readonly log: (m: string) => void) {}

  /** Speak text; sentences are synthesised ahead while earlier ones play. */
  speak(text: string) {
    const gen = this.generation
    const sentences = splitSentences(text)
    // Each sentence is made after the one before, so whichever engine answers first keeps the whole
    // utterance: her voice doesn't change halfway through a thought.
    const lock: { engine: Engine | null } = { engine: null }
    let prev: Promise<unknown> = Promise.resolve()
    const jobs = sentences.map((s) => {
      const job = prev.then(() => (gen === this.generation ? this.synth(s, lock) : null))
      prev = job
      return job
    })
    this.pendingGen = gen
    this.pending++
    this.queue = this.queue.then(async () => {
      for (let i = 0; i < jobs.length; i++) {
        const r = await jobs[i]
        if (gen !== this.generation) return
        if (r) this.out.enqueueFloat(r.samples, r.rate)
        else {
          // Don't talk over a sentence that is still playing from another engine.
          while (this.out.speaking && gen === this.generation) await new Promise((res) => setTimeout(res, 50))
          if (gen === this.generation) await this.systemSpeak(sentences[i])
        }
      }
    }).finally(() => {
      this.pending--
      if (!this.pending && gen === this.generation && !this.out.speaking) this.onIdle?.()
    })
  }

  /** Resolves once everything queued has been said (or after maxMs), so her hands don't run ahead of her words. */
  async drained(maxMs = 20000) {
    const until = Date.now() + maxMs
    await Promise.race([this.queue, new Promise((r) => setTimeout(r, maxMs))])
    while (this.out.speaking && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
  }

  stop() {
    this.generation++
    speechSynthesis.cancel()
    this.out.stop()
  }

  private async synth(text: string, lock: { engine: Engine | null }): Promise<{ samples: Float32Array; rate: number } | null> {
    if (lock.engine === 'system') return null
    if (this.cloud && navigator.onLine && lock.engine !== 'kokoro') {
      const r = await this.cloud(text).catch((err: Error) => { this.log(`cloud tts: ${err.message}`); return null })
      if (r) { lock.engine = 'cloud'; return r }
    }
    if (!this.localTts || this.kokoroSlow || /[ऀ-ॿ]/.test(text)) { lock.engine = 'system'; return null }
    const r = await this.localTts(text).catch((err: Error) => { this.log(`local tts: ${err.message}`); return null })
    if (r?.ms != null) {
      this.lastMs = r.ms
      const audioMs = (r.samples.length / r.rate) * 1000
      // The first call includes loading the model; judge speed from the second call on.
      if (++this.kokoroCalls >= 2 && r.ms > audioMs * 0.9) {
        this.kokoroSlow = true
        try { localStorage.setItem(SLOW_KEY, '1') } catch { /* only a convenience */ }
        this.log(`kokoro too slow here (${Math.round(r.ms)} ms for ${Math.round(audioMs)} ms of speech); using the Windows voice offline`)
      }
    }
    if (r) lock.engine = 'kokoro'
    return r
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
