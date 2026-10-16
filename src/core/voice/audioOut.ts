/**
 * Plays her voice: streamed 24 kHz PCM16 chunks from Gemini Live, or whole Float32 buffers from Kokoro.
 * Chunks are scheduled back-to-back for gapless speech. An analyser exposes the loudness for lip-sync.
 */
export class AudioOut {
  readonly ctx = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' })
  private readonly gain = this.ctx.createGain()
  private readonly analyser = this.ctx.createAnalyser()
  private readonly buf = new Float32Array(512)
  private sources = new Set<AudioBufferSourceNode>()
  private playHead = 0
  private endedCb: (() => void) | null = null
  volume = 1

  constructor() {
    this.analyser.fftSize = 512
    this.gain.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
  }

  get speaking() { return this.sources.size > 0 }

  /** Fires once the queue drains after audio was playing. */
  onEnded(cb: () => void) { this.endedCb = cb }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined)
  }

  /** base64 little-endian PCM16 mono at `rate` Hz. */
  enqueuePcm16(b64: string, rate = 24000) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const view = new DataView(bytes.buffer)
    const n = bytes.byteLength >> 1
    const f = new Float32Array(n)
    for (let i = 0; i < n; i++) f[i] = view.getInt16(i * 2, true) / 32768
    this.enqueueFloat(f, rate)
  }

  enqueueFloat(samples: Float32Array, rate: number) {
    if (!samples.length) return
    void this.resume()
    const ab = this.ctx.createBuffer(1, samples.length, rate)
    ab.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const src = this.ctx.createBufferSource()
    src.buffer = ab
    src.connect(this.gain)
    this.gain.gain.value = this.volume
    const now = this.ctx.currentTime
    // A small lead on the first chunk absorbs network jitter without adding noticeable delay.
    const start = Math.max(now + (this.sources.size ? 0 : 0.05), this.playHead)
    src.start(start)
    this.playHead = start + ab.duration
    this.sources.add(src)
    src.onended = () => {
      this.sources.delete(src)
      if (!this.sources.size) this.endedCb?.()
    }
  }

  /** Barge-in: silence immediately and drop everything queued. */
  stop() {
    for (const s of this.sources) {
      s.onended = null
      try { s.stop() } catch { /* already stopped */ }
    }
    const had = this.sources.size > 0
    this.sources.clear()
    this.playHead = this.ctx.currentTime
    if (had) this.endedCb?.()
  }

  /** 0..1 loudness of what is playing right now. */
  level(): number {
    if (!this.sources.size) return 0
    this.analyser.getFloatTimeDomainData(this.buf)
    let sum = 0
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i]
    const rms = Math.sqrt(sum / this.buf.length)
    return Math.min(1, Math.max(0, (rms - 0.01) * 6))
  }
}
