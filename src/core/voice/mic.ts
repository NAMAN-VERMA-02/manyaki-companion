import { MicVAD } from '@ricky0123/vad-web'

export interface MicEvents {
  /** Speech started (after the VAD is confident). `preRoll` is ~300 ms of audio before the trigger. */
  onSpeechStart(preRoll: Float32Array[]): void
  /** A 16 kHz mono frame while speech is active (and for a short tail afterwards). */
  onFrame(frame: Float32Array): void
  /** Speech ended; `audio` is the whole utterance at 16 kHz when the VAD has it (used by the text fallback). */
  onSpeechEnd(audio?: Float32Array): void
  onError(msg: string): void
}

const VENDOR = 'manyaki-asset://vendor/vad/'

/**
 * Her ears. Silero VAD runs locally on the mic so nothing leaves the PC until you actually speak.
 * Echo cancellation keeps her own voice out; while she talks the threshold is raised so only a clear
 * interruption (barge-in) gets through.
 */
export class Mic {
  private vad: MicVAD | null = null
  private active = false
  private ring: Float32Array[] = []
  private tail = 0
  private herSpeaking = false
  enabled = false

  constructor(private readonly ev: MicEvents) {}

  async start(): Promise<boolean> {
    if (this.vad) {
      await this.vad.start()
      this.enabled = true
      return true
    }
    try {
      this.vad = await MicVAD.new({
        model: 'v5',
        baseAssetPath: VENDOR,
        onnxWASMBasePath: VENDOR,
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.4,
        redemptionMs: 700,
        preSpeechPadMs: 300,
        minSpeechMs: 250,
        startOnLoad: true,
        getStream: () =>
          navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          }),
        onFrameProcessed: (p, frame) => this.frame(p.isSpeech, frame),
        onSpeechRealStart: () => {
          this.active = true
          this.ev.onSpeechStart(this.ring.splice(0))
        },
        onSpeechEnd: (audio) => this.end(audio),
        onVADMisfire: () => this.end()
      })
      this.enabled = true
      return true
    } catch (err) {
      this.ev.onError((err as Error).message || String(err))
      return false
    }
  }

  async stop() {
    this.enabled = false
    this.end()
    await this.vad?.pause()
  }

  /** While she is talking, require more confident speech so her echo can't trigger a barge-in. */
  setHerSpeaking(speaking: boolean) {
    if (speaking === this.herSpeaking) return
    this.herSpeaking = speaking
    this.vad?.setOptions(speaking
      ? { positiveSpeechThreshold: 0.85, negativeSpeechThreshold: 0.6 }
      : { positiveSpeechThreshold: 0.6, negativeSpeechThreshold: 0.4 })
  }

  private frame(_isSpeech: number, frame: Float32Array) {
    if (this.active || this.tail > 0) {
      this.ev.onFrame(frame)
      if (!this.active) this.tail--
      return
    }
    // Keep ~640 ms of history (VAD confirmation delay + padding) so the first syllable is not clipped.
    this.ring.push(frame)
    if (this.ring.length > 20) this.ring.shift()
  }

  private end(audio?: Float32Array) {
    if (!this.active) return
    this.active = false
    this.tail = 6 // ~200 ms more audio helps the server's end-of-turn detection
    this.ev.onSpeechEnd(audio)
  }
}

/** Float32 [-1,1] -> base64 PCM16 little-endian. */
export function floatToPcm16Base64(chunks: Float32Array[]): string {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Uint8Array(n * 2)
  const view = new DataView(out.buffer)
  let o = 0
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]))
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      o += 2
    }
  }
  let bin = ''
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000))
  return btoa(bin)
}
