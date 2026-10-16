import type { AudioOut } from './audioOut'

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
  /** Kokoro too slow on this machine (synthesis slower than playback): skip it. */
  kokoroSlow = false
  private kokoroCalls = 0

  constructor(private readonly out: AudioOut, private readonly log: (m: string) => void) {}

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
        else {
          // Don't talk over a sentence that is still playing from another engine.
          while (this.out.speaking && gen === this.generation) await new Promise((res) => setTimeout(res, 50))
          if (gen === this.generation) await this.systemSpeak(sentences[i])
        }
      }
    })
  }

  stop() {
    this.generation++
    speechSynthesis.cancel()
    this.out.stop()
  }

  private async synth(text: string): Promise<{ samples: Float32Array; rate: number } | null> {
    if (this.cloud && navigator.onLine) {
      const r = await this.cloud(text).catch((err: Error) => { this.log(`cloud tts: ${err.message}`); return null })
      if (r) return r
    }
    if (!this.localTts || this.kokoroSlow || /[ऀ-ॿ]/.test(text)) return null
    const r = await this.localTts(text).catch((err: Error) => { this.log(`local tts: ${err.message}`); return null })
    if (r?.ms != null) {
      this.lastMs = r.ms
      const audioMs = (r.samples.length / r.rate) * 1000
      // The first call includes loading the model; judge speed from the second call on.
      if (++this.kokoroCalls >= 2 && r.ms > audioMs * 0.9) {
        this.kokoroSlow = true
        this.log(`kokoro too slow here (${Math.round(r.ms)} ms for ${Math.round(audioMs)} ms of speech); using the Windows voice offline`)
      }
    }
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
