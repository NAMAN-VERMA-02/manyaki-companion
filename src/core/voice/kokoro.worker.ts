/// <reference lib="webworker" />
// Local fallback voice. Runs Kokoro-82M inside a worker so the render loop never stutters.
// The model (~90 MB) downloads from Hugging Face on first use and is cached by the browser.
import { KokoroTTS } from 'kokoro-js'

let tts: KokoroTTS | null = null
let loading: Promise<KokoroTTS> | null = null

async function load(): Promise<KokoroTTS> {
  if (tts) return tts
  if (!loading) {
    const webgpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null))
    loading = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: webgpu ? 'fp32' : 'q8',
      device: webgpu ? 'webgpu' : 'wasm',
      progress_callback: (p: { status: string; progress?: number }) => {
        if (p.status === 'progress' && p.progress != null) postMessage({ type: 'progress', value: p.progress / 100 })
      }
    })
  }
  tts = await loading
  postMessage({ type: 'ready' })
  return tts
}

self.onmessage = async (e: MessageEvent<{ type: 'load' } | { type: 'speak'; id: number; text: string; voice: string; speed: number }>) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      await load()
      return
    }
    const model = await load()
    const t0 = performance.now()
    const audio = await model.generate(msg.text, { voice: msg.voice as 'af_heart', speed: msg.speed })
    const samples = audio.audio as Float32Array
    postMessage({ type: 'audio', id: msg.id, samples, rate: audio.sampling_rate, ms: performance.now() - t0 }, [samples.buffer])
  } catch (err) {
    postMessage({ type: 'error', id: 'id' in msg ? msg.id : -1, message: (err as Error).message })
  }
}
