import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import { AutoProcessor, Florence2ForConditionalGeneration, RawImage, env, pipeline, type Processor, type TokenClassificationPipeline } from '@huggingface/transformers'
import type { Box } from '../../shared/protocol'

// On-device vision, inside the extension (nothing here touches the network except downloading model
// weights once from Hugging Face; the extension's own code and WASM are bundled).
//
// - Faces: MediaPipe BlazeFace (≈230 KB), GPU delegate with CPU fallback, a few ms per frame. Run on the
//   whole screenshot and again on each image/video region scaled up, so small avatars are found too.
// - Deep vision (opt-in, once ≈250 MB): Florence-2-base, a vision transformer (DaViT encoder) via
//   transformers.js on WebGPU (WASM fallback): OCR-with-regions to find private text inside pixels
//   (images, canvas, cross-origin frames) and a caption of the screen for context.
// - Names: a BERT NER model (≈110 MB, quantised) finds people's names in the page text.

const url = (p: string) => chrome.runtime.getURL(p)

env.allowLocalModels = false
env.useBrowserCache = true
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = url('ort/')
  env.backends.onnx.wasm.numThreads = 1 // extension pages aren't cross-origin isolated: no SharedArrayBuffer
}

export const hasWebGPU = async (): Promise<boolean> => {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    return !!(gpu && (await gpu.requestAdapter()))
  } catch { return false }
}

export interface ModelInfo { name: string; backend: string; loadMs: number; ready: boolean; error?: string }

// ---------------- faces ----------------

let faceDetector: FaceDetector | null = null
let faceLoading: Promise<FaceDetector | null> | null = null
export const faceInfo: ModelInfo = { name: 'BlazeFace short-range (MediaPipe)', backend: '-', loadMs: 0, ready: false }

export function loadFaces(): Promise<FaceDetector | null> {
  if (faceDetector) return Promise.resolve(faceDetector)
  faceLoading ??= (async () => {
    const t0 = performance.now()
    const fileset = await FilesetResolver.forVisionTasks(url('mediapipe'))
    const make = (delegate: 'GPU' | 'CPU') => FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: url('models/blaze_face_short_range.tflite'), delegate },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.45,
      minSuppressionThreshold: 0.3
    })
    try {
      faceDetector = await make('GPU')
      faceInfo.backend = 'GPU (WebGL)'
    } catch {
      faceDetector = await make('CPU')
      faceInfo.backend = 'CPU (WASM)'
    }
    faceInfo.loadMs = performance.now() - t0
    faceInfo.ready = true
    return faceDetector
  })().catch((e: Error) => { faceInfo.error = e.message; faceLoading = null; return null })
  return faceLoading
}

export interface FaceHit { box: Box; score: number }

/**
 * Faces in a screenshot canvas (CSS-pixel scale). `regions` are image/video boxes to re-check at a
 * larger scale: BlazeFace is tuned for faces that fill a good part of the frame.
 */
export async function detectFaces(canvas: HTMLCanvasElement, regions: Box[]): Promise<FaceHit[]> {
  const fd = await loadFaces()
  if (!fd) return []
  const hits: FaceHit[] = []
  const run = (src: HTMLCanvasElement, ox: number, oy: number, scale: number) => {
    const r = fd.detect(src)
    for (const d of r.detections) {
      const b = d.boundingBox
      if (!b) continue
      hits.push({ box: { x: ox + b.originX / scale, y: oy + b.originY / scale, w: b.width / scale, h: b.height / scale }, score: d.categories[0]?.score ?? 0.5 })
    }
  }
  run(canvas, 0, 0, 1)
  const crop = document.createElement('canvas')
  const cctx = crop.getContext('2d', { willReadFrequently: false })!
  for (const reg of regions.slice(0, 24)) {
    if (reg.w < 28 || reg.h < 28) continue
    const scale = Math.min(4, Math.max(1, 320 / Math.min(reg.w, reg.h)))
    crop.width = Math.round(reg.w * scale)
    crop.height = Math.round(reg.h * scale)
    cctx.drawImage(canvas, reg.x, reg.y, reg.w, reg.h, 0, 0, crop.width, crop.height)
    run(crop, reg.x, reg.y, scale)
  }
  return nms(hits, 0.3).map((h) => ({ ...h, box: pad(h.box, 0.18, canvas.width, canvas.height) }))
}

function iou(a: Box, b: Box) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w), t = Math.min(a.y + a.h, b.y + b.h)
  const i = Math.max(0, r - x) * Math.max(0, t - y)
  return i / (a.w * a.h + b.w * b.h - i || 1)
}
function nms(h: FaceHit[], thr: number): FaceHit[] {
  const out: FaceHit[] = []
  for (const x of [...h].sort((a, b) => b.score - a.score)) if (!out.some((o) => iou(o.box, x.box) > thr)) out.push(x)
  return out
}
const pad = (b: Box, k: number, W: number, H: number): Box => {
  const x = Math.max(0, b.x - b.w * k), y = Math.max(0, b.y - b.h * k * 1.3)
  return { x, y, w: Math.min(W - x, b.w * (1 + 2 * k)), h: Math.min(H - y, b.h * (1 + 2.3 * k)) }
}

// ---------------- Florence-2 (deep vision) ----------------

const FLORENCE = 'onnx-community/Florence-2-base-ft'
interface Florence { model: Florence2ForConditionalGeneration; processor: Processor }
let florence: Florence | null = null
let florenceLoading: Promise<Florence | null> | null = null
export const florenceInfo: ModelInfo = { name: 'Florence-2-base (ViT/DaViT, 0.23B)', backend: '-', loadMs: 0, ready: false }

export function loadFlorence(onProgress?: (p: number) => void): Promise<Florence | null> {
  if (florence) return Promise.resolve(florence)
  florenceLoading ??= (async (): Promise<Florence | null> => {
    const t0 = performance.now()
    const gpu = await hasWebGPU()
    const progress = (p: { status?: string; progress?: number }) => { if (p.status === 'progress' && p.progress != null) onProgress?.(p.progress) }
    const model = (await Florence2ForConditionalGeneration.from_pretrained(FLORENCE, gpu
      ? { device: 'webgpu', dtype: { embed_tokens: 'fp16', vision_encoder: 'fp16', encoder_model: 'q4', decoder_model_merged: 'q4' }, progress_callback: progress }
      : { device: 'wasm', dtype: { embed_tokens: 'fp32', vision_encoder: 'fp32', encoder_model: 'q8', decoder_model_merged: 'q8' }, progress_callback: progress })) as Florence2ForConditionalGeneration
    const processor = await AutoProcessor.from_pretrained(FLORENCE)
    florenceInfo.backend = gpu ? 'WebGPU' : 'WASM'
    florenceInfo.loadMs = performance.now() - t0
    florenceInfo.ready = true
    florence = { model, processor }
    return florence
  })().catch((e: Error) => { florenceInfo.error = e.message; florenceLoading = null; return null })
  return florenceLoading
}

type FlorenceProcessor = Processor & {
  construct_prompts(t: string): string[]
  post_process_generation(text: string, task: string, size: [number, number]): Record<string, unknown>
  batch_decode(ids: unknown, o: { skip_special_tokens: boolean }): string[]
}

async function florenceTask(canvas: HTMLCanvasElement, task: string, maxTokens: number): Promise<Record<string, unknown> | null> {
  const f = await loadFlorence()
  if (!f) return null
  const image = RawImage.fromCanvas(canvas)
  const p = f.processor as FlorenceProcessor
  const inputs = await p(image, p.construct_prompts(task))
  const ids = await f.model.generate({ ...inputs, max_new_tokens: maxTokens })
  const text = p.batch_decode(ids, { skip_special_tokens: false })[0]
  return p.post_process_generation(text, task, [image.height, image.width])
}

export interface OcrLine { text: string; box: Box }

/** Text and where it is, read from pixels (the screenshot downscaled to `maxSide` for speed). */
export async function ocr(screen: HTMLCanvasElement, maxSide = 1024): Promise<OcrLine[]> {
  const scale = Math.min(1, maxSide / Math.max(screen.width, screen.height))
  const c = document.createElement('canvas')
  c.width = Math.round(screen.width * scale)
  c.height = Math.round(screen.height * scale)
  c.getContext('2d')!.drawImage(screen, 0, 0, c.width, c.height)
  const r = await florenceTask(c, '<OCR_WITH_REGION>', 512)
  const o = r?.['<OCR_WITH_REGION>'] as { quad_boxes?: number[][]; labels?: string[] } | undefined
  if (!o?.labels) return []
  return o.labels.map((label, i) => {
    const q = o.quad_boxes?.[i] ?? []
    const xs = [q[0], q[2], q[4], q[6]].filter((v) => v != null)
    const ys = [q[1], q[3], q[5], q[7]].filter((v) => v != null)
    const x = Math.min(...xs) / scale, y = Math.min(...ys) / scale
    return { text: label.replace(/<\/?s>/g, '').trim(), box: { x, y, w: Math.max(...xs) / scale - x, h: Math.max(...ys) / scale - y } }
  }).filter((l) => l.text && Number.isFinite(l.box.x))
}

/** A one-paragraph description of the screen (run on the REDACTED canvas, so it never names anyone). */
export async function caption(redacted: HTMLCanvasElement): Promise<string> {
  const c = document.createElement('canvas')
  const scale = Math.min(1, 768 / Math.max(redacted.width, redacted.height))
  c.width = Math.round(redacted.width * scale)
  c.height = Math.round(redacted.height * scale)
  c.getContext('2d')!.drawImage(redacted, 0, 0, c.width, c.height)
  const r = await florenceTask(c, '<MORE_DETAILED_CAPTION>', 96)
  return String(r?.['<MORE_DETAILED_CAPTION>'] ?? '').trim()
}

// ---------------- names (NER) ----------------

let ner: TokenClassificationPipeline | null = null
let nerLoading: Promise<TokenClassificationPipeline | null> | null = null
export const nerInfo: ModelInfo = { name: 'BERT-base NER (quantised)', backend: '-', loadMs: 0, ready: false }

export function loadNer(): Promise<TokenClassificationPipeline | null> {
  if (ner) return Promise.resolve(ner)
  nerLoading ??= (async () => {
    const t0 = performance.now()
    const gpu = await hasWebGPU()
    // Typed loosely: pipeline()'s overloads make the union of option types too big for the compiler.
    const make = pipeline as unknown as (task: string, model: string, o: Record<string, unknown>) => Promise<TokenClassificationPipeline>
    ner = await make('token-classification', 'Xenova/bert-base-NER', gpu ? { device: 'webgpu', dtype: 'fp32' } : { device: 'wasm', dtype: 'q8' })
    nerInfo.backend = gpu ? 'WebGPU' : 'WASM'
    nerInfo.loadMs = performance.now() - t0
    nerInfo.ready = true
    return ner
  })().catch((e: Error) => { nerInfo.error = e.message; nerLoading = null; return null })
  return nerLoading
}

/**
 * People's names in a text, as character spans. The pipeline gives word pieces without offsets, so the
 * merged names are located back in the text in order.
 */
export async function findNames(text: string): Promise<{ start: number; end: number; score: number }[]> {
  const p = await loadNer()
  if (!p || text.length < 3) return []
  const out = (await p(text.slice(0, 512))) as { entity: string; score: number; word: string }[]
  const names: { name: string; score: number }[] = []
  for (const t of out) {
    const piece = t.word.startsWith('##') ? t.word.slice(2) : t.word
    const isPer = /PER$/.test(t.entity)
    const last = names[names.length - 1]
    if (isPer && (t.entity.startsWith('I-') || t.word.startsWith('##')) && last) {
      last.name += t.word.startsWith('##') ? piece : ` ${piece}`
      last.score = Math.min(last.score, t.score)
    } else if (isPer) names.push({ name: piece, score: t.score })
  }
  const spans: { start: number; end: number; score: number }[] = []
  let from = 0
  for (const n of names) {
    if (n.score < 0.6 || n.name.replace(/\W/g, '').length < 2) continue
    const i = text.indexOf(n.name, from)
    if (i < 0) continue
    spans.push({ start: i, end: i + n.name.length, score: n.score })
    from = i + n.name.length
  }
  return spans
}
