# Manyaki Eyes: a privacy-preserving browser vision agent

A browser extension (Chrome, Edge, Firefox) that sees the page on your device, hides everything private **before any network request**, and asks a server-side model for the next UI actions. The server never receives a password, card number, ID, email, phone number, name or face. It gets typed tokens such as `[[EMAIL_1]]`, and the extension types the real values back in locally.

Manyaki (the desktop companion) hosts the server, narrates what the agent is doing, and takes browser tasks by voice: *"in my browser, search for wireless earbuds"*.

```
 BROWSER (on device)                                                 SERVER (sanitised only)
 ┌───────────────────────────────────────────────────────────┐      ┌──────────────────────────────┐
 │ content.ts   DOM perception: elements, roles, labels,     │      │ server.ts   /v1/step          │
 │              values, exact text-node rects, shadow DOM,   │      │   leak guard (2nd check)      │
 │              same-origin iframes, payment iframes         │      │   planner.ts  prompt + parse  │
 │ vision.ts    BlazeFace faces · Florence-2 OCR + caption   │ ───► │   providers.ts                │
 │              (ViT/DaViT, WebGPU→WASM) · BERT NER names    │ JSON │     Ollama (open weights)     │
 │ pii.ts       spans: regex + checksums + context + fields  │ ◄─── │     OpenAI-compatible (vLLM…) │
 │ vault.ts     value ↔ [[TYPE_n]] tokens (never leaves)     │ acts │     Gemini (last resort)      │
 │ redact.ts    black bars + labels, irreversible mosaics    │      │     rules (no model)          │
 │ leakguard    re-scan the exact outgoing payload           │      └──────────────────────────────┘
 │ agent.ts     act → restore values locally → confirm risky │
 └───────────────────────────────────────────────────────────┘
```

## What makes it robust

- **Hybrid perception.** The DOM gives exact structure and the pixel-exact boxes of private text (a `Range` over the text node, down to the characters of `a@b.com` in a sentence). Pixels cover what the DOM can't: faces in images, text in canvas, images and cross-origin frames. A mirror element measures characters inside `<input>`/`<textarea>`, so a phone number in a delivery note is covered without blacking out the whole note.
- **Detectors that know what they're looking at.** Luhn for cards, Verhoeff for Aadhaar, PAN/IFSC/UPI shapes, context ("Name:", "DOB", "Posted by …", "password Tr0ub4dor&3"), label/value pairing for tables and `<dt>/<dd>` layouts, form-field semantics (`type`, `autocomplete`, names, labels), and payment iframes (Stripe, Razorpay…) treated as card data. Version strings, prices, order codes and SKUs are deliberately not flagged.
- **Semantic redaction.** A black box carries its token (`EMAIL_1`), so a vision model on the server still knows *what* is there. Faces get a noisy mosaic, which can't be sharpened back the way a blur can.
- **Defence in depth.** A leak guard re-scans the exact payload on the client before sending and again on the server before planning. Anything it catches is masked and counted in the metrics.
- **Safe acting.** Server output is untrusted: unknown ids are dropped and values clamped. Paying, deleting, sending or leaving the site needs your OK. A secret token may only be typed into a field of the same kind, so a manipulated planner can't make `[[PASSWORD_1]]` appear in a search box. Page text is data, never instructions.
- **Pairing.** The server only answers browser extensions with the pairing code, never ordinary web pages.

## Run it

```bash
npm run eyes:build        # builds eyes/extension/dist (≈36 MB; bundles MediaPipe + onnxruntime WASM)
npm run eyes:server       # standalone server on 127.0.0.1:47821 (or just run Manyaki: it hosts it)
```

- **Chrome/Edge:** `chrome://extensions` → Developer mode → Load unpacked → `eyes/extension/dist`.
- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → `eyes/extension/dist/manifest.json`.
- Click the 👁️ icon to open the side panel. When the server is Manyaki, paste the pairing code from Manyaki Home → Eyes.

**Planner models.** By default the planner uses Ollama if it's installed, preferring vision models (`ollama pull qwen2.5vl:3b`, `gemma3`, `llama3.2-vision`, `minicpm-v`…). Otherwise it uses any OpenAI-compatible endpoint (`EYES_PROVIDER=openai EYES_BASE_URL=http://gpu-box:8000/v1 EYES_MODEL=Qwen/Qwen2.5-VL-7B-Instruct`), then Gemini, then the rule planner, which handles log in, search, click/choose/like, multi-step "X and then Y", and "the post about X".

## Measure it

The benchmark serves labelled pages from `eyes/fixtures/`. Every private value is wrapped in `data-truth="TYPE"`, so ground truth is pixel-exact. It runs the **same pipeline the agent uses** and reports each evaluation criterion:

```bash
node eyes/tests/run-bench.mjs --reps 3          # fast mode (DOM + text detectors + BlazeFace)
node eyes/tests/run-bench.mjs --deep --reps 1   # + Florence-2 OCR/caption and NER
```

Or open the 📊 button in the panel. The runner uses a throwaway browser profile.

Measured on this laptop (Edge 155 headless, integrated GPU, rule planner, 15 views across 5 pages):

| Criterion | Result |
|---|---|
| ① Visual context: UI targets found / correctly labelled | 100% / 100% |
| ① End-to-end tasks (login, checkout, social, shop) | 4/4 |
| ② PII detection precision / recall (F1) | 100% / 94.7% (97.3%) |
| ② False alarms on the page with no personal data | 0 |
| ③ Redaction pixel precision / recall | 100% / 93.3% |
| ④ On-device time per view (warm p50) | ≈130 ms |
| ④ JS heap with face model loaded | ≈10 MB |
| ⑤ End-to-end task latency p50 / p95 | 1.6 / 1.7 s |

The only PII fast mode misses is a phone number drawn on a `<canvas>`, which exists only in pixels. Deep mode's OCR is there for that case. **Deep mode is not benchmarked yet:** the models load and run in the browser, but the weight download from Hugging Face failed on the network these numbers were measured on. Deep models load in the background, so steps keep running in fast mode until they're ready, and every deep stage has a time budget. Face scores need portrait photos you have rights to: drop them into `eyes/fixtures/faces/` with a `faces.json` (format in `faces.html`).

## Files

| Path | What |
|---|---|
| `shared/protocol.ts` | wire format `manyaki-eyes/1` |
| `shared/pii.ts` | span detectors, checksums, field classifier |
| `shared/vault.ts` | tokens ↔ values (client only) |
| `shared/leakguard.ts` | payload re-scan, used on both sides |
| `shared/metrics.ts` | precision/recall, IoU, pixel scores, latency percentiles |
| `shared/actions.ts` | JSON extraction, validation, risky-action rules |
| `extension/src/*` | content script, vision, redaction, pipeline, agent loop, panel, benchmark |
| `server/*` | HTTP server, prompt/parse, providers, rule planner |
| `fixtures/*` | labelled benchmark pages (synthetic people only) |
| `tests/run-bench.mjs` | headless benchmark runner |
