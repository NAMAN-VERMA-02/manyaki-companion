import { SCHEME, type Box, type DetectionSource, type HistoryItem, type PIIType, type Redaction, type ScreenElement, type StepRequest } from '../../shared/protocol'
import { findPII, resolveOverlaps, type Span } from '../../shared/pii'
import { scrubPayload } from '../../shared/leakguard'
import { intersect, area } from '../../shared/metrics'
import type { Vault } from '../../shared/vault'
import type { ContentRequest, Perception, RawElement } from './content'
import { caption, detectFaces, findNames, ocr } from './vision'
import { encode, redact, toCanvas, type Mark } from './redact'

// One observation of the current tab: perceive the DOM, capture pixels, find everything private (DOM
// rules, text patterns, names, faces, text in images), tokenise it, redact the screenshot, and build the
// request that is allowed to leave the browser. Used by the agent loop and by the benchmark.

export interface ObserveOptions {
  faces: boolean
  /** Florence-2 OCR + caption and NER names (downloads ≈360 MB once). */
  deep: boolean
  /** Attach the redacted screenshot to the request (for a vision model on the server). */
  sendImage: boolean
}

export interface Observation {
  request: StepRequest
  perception: Perception
  original: HTMLCanvasElement
  redacted: HTMLCanvasElement
  marks: Mark[]
  /** Per stage, ms. */
  timings: Record<string, number>
  bySource: Record<string, number>
  clientLeaks: number
  bytes: number
}

export async function send<T>(tabId: number, msg: ContentRequest): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>
}

/** Makes sure our content script is in the tab (tabs opened before install don't have it yet). */
export async function ensureContent(tabId: number): Promise<void> {
  try {
    await send(tabId, { type: 'ping' })
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content.js'] })
  }
}

const captionCache = new Map<string, string>()

export async function observe(tab: chrome.tabs.Tab, task: string, vault: Vault, history: HistoryItem[], step: number, opts: ObserveOptions): Promise<Observation> {
  const tabId = tab.id!
  const timings: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  const time = async <T>(k: string, f: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    try { return await f() } finally { timings[k] = (timings[k] ?? 0) + performance.now() - t0 }
  }

  await ensureContent(tabId)
  const perception = await time('perceive', () => send<Perception>(tabId, { type: 'perceive' }))
  const { page } = perception

  // Pixels: hide our own cursor/overlay so it isn't in the picture.
  const original = await time('capture', async () => {
    await send(tabId, { type: 'overlay', show: false })
    try {
      const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 })
      return toCanvas(shot, page.viewport.w, page.viewport.h)
    } finally {
      await send(tabId, { type: 'overlay', show: true }).catch(() => undefined)
    }
  })

  const redactions: Redaction[] = []
  const add = (type: PIIType, value: string, boxes: Box[], source: DetectionSource, confidence: number, elementId?: string) => {
    const token = vault.token(type, value)
    const existing = redactions.find((r) => r.token === token && r.elementId === elementId && r.source === source)
    if (existing) existing.boxes.push(...boxes)
    else redactions.push({ token, type, boxes, source, confidence, elementId })
    bySource[source] = (bySource[source] ?? 0) + 1
    return token
  }

  // ---- text: patterns + context everywhere; names via NER in deep mode ----
  const textJobs: { unit: string; text: string; spans: Span[]; elementId?: string }[] = []
  for (const t of perception.texts) textJobs.push({ unit: t.unit, text: t.text, spans: findPII(t.text) })
  pairLabels(perception, textJobs)
  for (const e of perception.elements) if (e.unit && e.unitText) textJobs.push({ unit: e.unit, text: e.unitText, spans: findPII(e.unitText), elementId: e.id })
  if (opts.deep) {
    await time('ner', async () => {
      for (const j of textJobs.slice(0, 120)) {
        if (!/[A-Z][a-z]+/.test(j.text)) continue
        const names = await findNames(j.text)
        if (names.length) j.spans = resolveOverlaps([...j.spans, ...names.map((n) => ({ start: n.start, end: n.end, type: 'NAME' as PIIType, source: 'context' as const, confidence: n.score }))])
      }
    })
  }
  const spanReqs = textJobs.flatMap((j) => j.spans.map((s) => ({ unit: j.unit, start: s.start, end: s.end })))
  const rects = spanReqs.length ? await time('rects', () => send<Box[][]>(tabId, { type: 'rects', spans: spanReqs })) : []
  let ri = 0
  const tokenisedUnits = new Map<string, string>()
  for (const j of textJobs) {
    let out = ''
    let i = 0
    for (const s of j.spans) {
      const value = j.text.slice(s.start, s.end)
      const src: DetectionSource = s.source === 'regex' ? 'regex' : opts.deep && s.type === 'NAME' && !/[:\-–]\s*$/.test(j.text.slice(0, s.start)) ? 'ner' : 'context'
      const token = add(s.type, value, rects[ri++] ?? [], src, s.confidence, j.elementId)
      out += j.text.slice(i, s.start) + token
      i = s.end
    }
    tokenisedUnits.set(j.unit, out + j.text.slice(i))
  }

  // ---- elements: field types from DOM attributes, values tokenised ----
  const freeText: { e: RawElement; el: ScreenElement; spans: Span[] }[] = []
  const elements: ScreenElement[] = perception.elements.map((e: RawElement) => {
    const el: ScreenElement = { id: e.id, role: e.role, tag: e.tag, label: '', box: e.box }
    el.label = e.unit ? tokenisedUnits.get(e.unit) ?? vault.tokenize(e.label).text : vault.tokenize(e.label).text
    if (e.field) el.sensitive = e.field
    if (e.value) {
      if (e.field && e.role !== 'select') el.value = add(e.field, e.value, [e.box], 'dom', 0.97, e.id)
      else freeText.push({ e, el, spans: findPII(e.value) })
    }
    if (e.checked !== undefined) el.checked = e.checked
    if (e.disabled) el.disabled = true
    if (e.href) el.href = e.href
    if (e.options) el.options = e.options.map((o) => vault.tokenize(o).text)
    return el
  })

  // Free text in a field (a note, a message): only the private parts become tokens, and on screen only
  // those characters are covered (measured with a mirror element in the page).
  const fieldSpans = freeText.flatMap((f) => f.spans.map((s) => ({ id: f.e.id, start: s.start, end: s.end })))
  const fieldBoxes = fieldSpans.length ? await time('rects', () => send<Box[][]>(tabId, { type: 'field-rects', spans: fieldSpans })) : []
  let fi = 0
  for (const f of freeText) {
    const v = f.e.value!
    let out = ''
    let i = 0
    for (const s of f.spans) {
      const boxes = fieldBoxes[fi++]
      out += v.slice(i, s.start) + add(s.type, v.slice(s.start, s.end), boxes?.length ? boxes : [f.e.box], s.source === 'regex' ? 'regex' : 'context', s.confidence, f.e.id)
      i = s.end
    }
    f.el.value = out + v.slice(i)
  }

  // Payment frames from another origin (Stripe, Razorpay…): treat the whole frame as card data.
  for (const img of perception.images) if (img.kind === 'iframe' && img.payment) add('CARD', `frame:${img.id}`, [img.box], 'dom', 0.9, img.id)

  // ---- pixels: faces, and (deep) text inside images/canvas/cross-origin frames ----
  const pixelRegions = perception.images.filter((i) => i.kind !== 'iframe' || i.crossOrigin).map((i) => i.box)
  if (opts.faces) {
    const faces = await time('faces', () => detectFaces(original, pixelRegions))
    faces.forEach((f, n) => add('FACE', `face:${step}:${n}:${Math.round(f.box.x)},${Math.round(f.box.y)}`, [f.box], 'face', f.score))
  }
  const vision: StepRequest['vision'] = {}
  if (opts.deep) {
    const lines = await time('ocr', () => ocr(original))
    const domBoxes = perception.texts.map((t) => t.box).concat(perception.elements.map((e) => e.box))
    const ocrOut: { text: string; box: Box }[] = []
    for (const l of lines) {
      const covered = domBoxes.some((b) => { const i = intersect(b, l.box); return !!i && area(i) > area(l.box) * 0.6 })
      const inPixels = pixelRegions.some((b) => { const i = intersect(b, l.box); return !!i && area(i) > area(l.box) * 0.5 })
      if (covered && !inPixels) continue // the DOM already told us this, exactly
      const spans = findPII(l.text)
      let text = ''
      let i = 0
      for (const s of spans) {
        // Character-proportional sub-box: OCR gives the line's box, not each character's.
        const x0 = l.box.x + (s.start / l.text.length) * l.box.w
        const x1 = l.box.x + (s.end / l.text.length) * l.box.w
        const tok = add(s.type, l.text.slice(s.start, s.end), [{ x: x0 - 2, y: l.box.y - 1, w: x1 - x0 + 4, h: l.box.h + 2 }], 'ocr', s.confidence * 0.9)
        text += l.text.slice(i, s.start) + tok
        i = s.end
      }
      ocrOut.push({ text: text + l.text.slice(i), box: l.box })
    }
    vision.ocr = ocrOut.slice(0, 40)
    vision.model = 'Florence-2-base'
  }

  // ---- redact pixels ----
  const marks: Mark[] = redactions.flatMap((r) => r.boxes.map((box) => ({ box, type: r.type, token: r.token })))
  const redacted = await time('redact', async () => redact(original, marks))
  if (opts.deep) {
    const key = `${page.url}#${Math.round(page.scrollY / 400)}`
    vision.caption = captionCache.get(key) ?? (await time('caption', () => caption(redacted)))
    captionCache.set(key, vision.caption)
    vision.caption = vault.tokenize(vision.caption).text
  }

  const prose = perception.texts.map((t) => ({ text: tokenisedUnits.get(t.unit) ?? t.text, box: t.box })).filter((t) => t.text.length > 1).slice(0, 60)
  let request: StepRequest = {
    scheme: SCHEME,
    task,
    page: { host: page.host, title: vault.tokenize(page.title).text, viewport: page.viewport, scrollY: page.scrollY, scrollMax: page.scrollMax },
    elements,
    text: prose.map((t) => t.text),
    textBoxes: prose.map((t) => round(t.box)),
    ...(opts.deep ? { vision } : {}),
    redactions: redactions.map((r) => ({ ...r, boxes: r.boxes.map(round) })),
    history,
    step
  }
  // Client leak guard on exactly what will be sent.
  const { clean, findings } = await time('guard', async () => scrubPayload(request))
  request = clean
  if (opts.sendImage) request.image = await time('encode', async () => encode(redacted))
  const bytes = JSON.stringify(request).length
  return { request, perception, original, redacted, marks, timings, bySource, clientLeaks: findings.length, bytes }
}

const round = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) })

// Label/value layouts (<dt>Name</dt><dd>Asha</dd>, table rows, "Name" above a value): the label and the
// value are separate blocks, so in-text context can't link them. A short label block followed by a
// value block on the same row (to its right) or just below marks the whole value.
const LABELS: [RegExp, PIIType, (v: string) => boolean][] = [
  [/^(full name|name|naam|customer name|account holder|card ?holder( name)?|beneficiary|patient name|student name|father'?s name|mother'?s name|guardian)\s*:?$/i, 'NAME', (v) => /^[A-Z][a-zA-Z'.-]+(\s+[A-Z][a-zA-Z'.-]+){0,3}$/.test(v)],
  [/^(dob|d\.o\.b\.?|date of birth|birth ?date|birthday)\s*:?$/i, 'DOB', (v) => /\d/.test(v) && v.length <= 24],
  [/^((residential|home|billing|shipping|permanent|current) )?address\s*:?$/i, 'ADDRESS', (v) => v.length >= 6 && v.length <= 160],
  [/^(pin ?code|pincode|postal code|zip( code)?)\s*:?$/i, 'PINCODE', (v) => /^\d{5,6}(-\d{4})?$/.test(v)],
  [/^(account (no\.?|number)|a\/c (no\.?|number)|acct\.? no\.?)\s*:?$/i, 'BANK_ACCOUNT', (v) => /^\d[\d\s-]{7,20}$/.test(v)],
  [/^(passport( no\.?| number)?)\s*:?$/i, 'PASSPORT', (v) => /^[A-Z0-9]{6,9}$/i.test(v)],
  [/^(voter id|epic( no\.?)?|driving licen[cs]e( no\.?)?|dl no\.?)\s*:?$/i, 'PASSPORT', (v) => /^[A-Z0-9 -]{6,18}$/i.test(v)]
]

function pairLabels(p: Perception, jobs: { unit: string; text: string; spans: Span[] }[]) {
  const texts = p.texts
  for (let i = 0; i < texts.length - 1; i++) {
    const label = texts[i]
    if (label.text.length > 40) continue
    const rule = LABELS.find(([re]) => re.test(label.text.trim()))
    if (!rule) continue
    const value = texts[i + 1]
    const v = value.text.trim()
    const sameRow = Math.abs((value.box.y + value.box.h / 2) - (label.box.y + label.box.h / 2)) < Math.max(label.box.h, 12) && value.box.x >= label.box.x + label.box.w - 4
    const below = value.box.y >= label.box.y + label.box.h - 4 && value.box.y - (label.box.y + label.box.h) < label.box.h * 1.5 && Math.abs(value.box.x - label.box.x) < 40
    if (!(sameRow || below) || !rule[2](v)) continue
    const job = jobs.find((j) => j.unit === value.unit)
    if (!job) continue
    const start = job.text.indexOf(v)
    job.spans = resolveOverlaps([...job.spans, { start, end: start + v.length, type: rule[1], source: 'context', confidence: 0.82 }])
  }
}
