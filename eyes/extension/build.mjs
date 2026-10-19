// Builds the Manyaki Eyes extension into eyes/extension/dist (load it unpacked in Chrome, or as a
// temporary add-on in Firefox from dist/manifest.json).
//
//   npm run eyes:build
//
// Everything the extension runs is bundled locally (MV3 forbids remote code): the pages, the content
// script and background as single files, MediaPipe's WASM, onnxruntime's WASM and the BlazeFace model.
// Florence-2 and NER weights are data, downloaded from Hugging Face on first use and cached.

import { build } from 'vite'
import sharp from 'sharp'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const src = join(here, 'src')
const out = join(here, 'dist')
const vendor = join(here, 'vendor')
const nm = join(root, 'node_modules')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const common = { configFile: false, logLevel: 'warn', define: { 'process.env.NODE_ENV': '"production"' } }

// 1. Pages (panel, benchmark): ES modules, no inline scripts (the extension CSP forbids them).
await build({
  ...common,
  root: src,
  base: './',
  publicDir: false,
  build: {
    outDir: out,
    emptyOutDir: false,
    target: 'esnext',
    modulePreload: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { panel: join(src, 'panel.html'), bench: join(src, 'bench.html') } }
  },
  worker: { format: 'es' }
})

// 2. Content script and background: one classic script each (no imports at runtime).
for (const name of ['content', 'background']) {
  await build({
    ...common,
    publicDir: false,
    build: {
      outDir: out,
      emptyOutDir: false,
      target: 'es2022',
      minify: true,
      lib: { entry: join(src, `${name}.ts`), formats: ['iife'], name: `ManyakiEyes_${name}`, fileName: () => `${name}.js` }
    }
  })
}

// 3. Static files.
cpSync(join(here, 'manifest.json'), join(out, 'manifest.json'))
await sharp(join(root, 'assets', 'icon.png')).resize(128, 128).png().toFile(join(out, 'icon.png'))
// MediaPipe: only the SIMD build of the classic loader (every current Chrome and Firefox has WASM SIMD).
mkdirSync(join(out, 'mediapipe'), { recursive: true })
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) cpSync(join(nm, '@mediapipe', 'tasks-vision', 'wasm', f), join(out, 'mediapipe', f))
// onnxruntime-web: served from ort/ (vision.ts sets wasmPaths); drop the duplicate Vite emitted.
mkdirSync(join(out, 'ort'), { recursive: true })
const ortDir = join(nm, '@huggingface', 'transformers', 'dist')
for (const f of readdirSync(ortDir)) if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) cpSync(join(ortDir, f), join(out, 'ort', f))
for (const f of readdirSync(join(out, 'assets'))) if (/^ort-wasm.*\.wasm$/.test(f)) rmSync(join(out, 'assets', f))

// 4. The BlazeFace model (≈230 KB, Apache-2.0), fetched once into vendor/.
const MODEL = 'blaze_face_short_range.tflite'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
mkdirSync(vendor, { recursive: true })
if (!existsSync(join(vendor, MODEL))) {
  try {
    const res = await fetch(MODEL_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    writeFileSync(join(vendor, MODEL), Buffer.from(await res.arrayBuffer()))
    console.log(`downloaded ${MODEL}`)
  } catch (e) {
    console.warn(`could not download the face model (${e.message}); face detection will be off until it is in eyes/extension/vendor/`)
  }
}
mkdirSync(join(out, 'models'), { recursive: true })
if (existsSync(join(vendor, MODEL))) cpSync(join(vendor, MODEL), join(out, 'models', MODEL))

console.log(`Manyaki Eyes built -> ${out}`)
console.log('Chrome: chrome://extensions → Developer mode → Load unpacked → eyes/extension/dist')
console.log('Firefox: about:debugging → This Firefox → Load Temporary Add-on → eyes/extension/dist/manifest.json')
