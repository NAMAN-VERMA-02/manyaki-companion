// Copies runtime assets (VAD model + worklet, onnxruntime wasm) out of node_modules
// so the renderer can load them through the manyaki-asset:// protocol in dev and prod.
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const out = 'assets/vendor/vad'
mkdirSync(out, { recursive: true })
const vad = 'node_modules/@ricky0123/vad-web/dist'
for (const f of ['silero_vad_v5.onnx', 'silero_vad_v6.onnx', 'silero_vad_legacy.onnx', 'vad.worklet.bundle.min.js']) cpSync(join(vad, f), join(out, f))
const ort = 'node_modules/onnxruntime-web/dist'
for (const f of readdirSync(ort)) if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) cpSync(join(ort, f), join(out, f))
console.log('vendor assets copied to', out)
