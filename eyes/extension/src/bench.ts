import type { Box } from '../../shared/protocol'
import { area, intersect, matchBoxes, pixelScores, prf, Timer, type PRF } from '../../shared/metrics'
import { Vault } from '../../shared/vault'
import { Agent, type AgentSettings } from './agent'
import { observe, send, ensureContent, type Observation } from './pipeline'
import { faceInfo, florenceInfo, nerInfo } from './vision'

// Benchmark: opens each labelled fixture (served by the Eyes server), runs the same observe pipeline the
// agent uses, compares it with the page's ground truth, and (optionally) runs the page's end-to-end task.
// Results map onto the evaluation criteria: visual-context accuracy, PII precision/recall, redaction
// precision, client resources, end-to-end latency.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

interface Truth { items: { type: string; boxes: Box[] }[]; ui: { label: string; box: Box }[]; title: string; meta: Record<string, string> }

interface PageResult {
  page: string
  detection: PRF
  typeAccuracy: number
  pixels: ReturnType<typeof pixelScores>
  faces: PRF | null
  ui: { found: number; total: number; labelled: number }
  falseOnNegativePage: number
  timings: Record<string, number>
  clientMs: number
  bytes: number
  heapMB: number
  e2e: { task: string; ok: boolean; ms: number; steps: number; serverMs: number } | null
}

let results: PageResult[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function settings(): Promise<AgentSettings> {
  const s = (await chrome.storage.local.get('settings')) as { settings?: Partial<AgentSettings> }
  return {
    serverUrl: 'http://127.0.0.1:47821', pairing: '', sendImage: true, maxSteps: 8, ...s.settings,
    faces: $<HTMLInputElement>('faces').checked,
    deep: $<HTMLInputElement>('deep').checked
  }
}

async function openAndWait(url: string, tabId?: number): Promise<chrome.tabs.Tab> {
  const tab = tabId ? await chrome.tabs.update(tabId, { url, active: true }) : await chrome.tabs.create({ url, active: true })
  for (let i = 0; i < 100; i++) {
    const t = await chrome.tabs.get(tab!.id!)
    if (t.status === 'complete') break
    await sleep(100)
  }
  await sleep(600) // fonts, canvas drawing
  return chrome.tabs.get(tab!.id!)
}

function heap(): number {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  return m ? m.usedJSHeapSize / 1048576 : 0
}

function score(o: Observation, truth: Truth): Omit<PageResult, 'page' | 'e2e' | 'timings' | 'clientMs' | 'bytes' | 'heapMB'> {
  const textTruth = truth.items.filter((t) => t.type !== 'FACE')
  const faceTruth = truth.items.filter((t) => t.type === 'FACE')
  const predText = o.marks.filter((m) => m.type !== 'FACE')
  const predFace = o.marks.filter((m) => m.type === 'FACE')

  // Item-level detection: a truth item is found if any predicted box covers most of one of its boxes.
  let tp = 0
  let typed = 0
  const usedPred = new Set<number>()
  for (const t of textTruth) {
    let hit = -1
    predText.forEach((p, i) => {
      if (hit >= 0) return
      for (const b of t.boxes) {
        const x = intersect(p.box, b)
        if (x && area(x) >= Math.min(area(b), area(p.box)) * 0.5) { hit = i; break }
      }
    })
    if (hit >= 0) {
      tp++
      if (predText[hit].type === t.type || (t.type === 'NAME' && predText[hit].type === 'NAME')) typed++
      predText.forEach((p, i) => { if (t.boxes.some((b) => { const x = intersect(p.box, b); return x && area(x) > area(p.box) * 0.3 })) usedPred.add(i) })
    }
  }
  const fp = predText.filter((_, i) => !usedPred.has(i)).length
  const detection = prf(tp, fp, textTruth.length - tp)

  const truthBoxes = textTruth.flatMap((t) => t.boxes)
  const pixels = pixelScores(predText.map((m) => m.box), truthBoxes)
  const faces = faceTruth.length ? matchBoxes(predFace.map((m) => m.box), faceTruth.flatMap((t) => t.boxes), 0.3) : null

  // Visual context: did perception find each labelled UI target, with the right label?
  let found = 0
  let labelled = 0
  for (const u of truth.ui) {
    const el = o.request.elements.find((e) => {
      const cx = e.box.x + e.box.w / 2, cy = e.box.y + e.box.h / 2
      return cx >= u.box.x - 4 && cx <= u.box.x + u.box.w + 4 && cy >= u.box.y - 4 && cy <= u.box.y + u.box.h + 4
    })
    if (el) {
      found++
      if (el.label.toLowerCase().includes(u.label.toLowerCase())) labelled++
    }
  }
  return {
    detection,
    typeAccuracy: tp ? typed / tp : 1,
    pixels,
    faces,
    ui: { found, total: truth.ui.length, labelled },
    falseOnNegativePage: textTruth.length === 0 ? predText.length : 0
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const cls = (x: number) => (x >= 0.9 ? 'good' : x >= 0.7 ? 'meh' : 'poor')

function render() {
  const sum = (f: (r: PageResult) => number) => results.reduce((a, r) => a + f(r), 0)
  const det = prf(sum((r) => r.detection.tp), sum((r) => r.detection.fp), sum((r) => r.detection.fn))
  const withPix = results.filter((r) => r.pixels.privatePx > 0 || r.pixels.redactedPx > 0)
  const pxP = withPix.length ? withPix.reduce((a, r) => a + r.pixels.precision * r.pixels.redactedPx, 0) / Math.max(1, withPix.reduce((a, r) => a + r.pixels.redactedPx, 0)) : 1
  const pxR = withPix.length ? withPix.reduce((a, r) => a + r.pixels.recall * r.pixels.privatePx, 0) / Math.max(1, withPix.reduce((a, r) => a + r.pixels.privatePx, 0)) : 1
  const uiT = sum((r) => r.ui.total)
  const uiF = sum((r) => r.ui.found)
  const uiL = sum((r) => r.ui.labelled)
  const client = new Timer(); for (const r of results) client.add(r.clientMs)
  const e2e = results.filter((r) => r.e2e).map((r) => r.e2e!)
  const e2eT = new Timer(); for (const e of e2e) e2eT.add(e.ms)
  const faces = results.filter((r) => r.faces).map((r) => r.faces!)
  const fprf = faces.length ? prf(faces.reduce((a, f) => a + f.tp, 0), faces.reduce((a, f) => a + f.fp, 0), faces.reduce((a, f) => a + f.fn, 0)) : null
  const rows: [string, string, number | null][] = [
    ['① Visual context: UI targets found / correctly labelled', uiT ? `${pct(uiF / uiT)} / ${pct(uiL / uiT)}` : '-', uiT ? uiL / uiT : null],
    ['① End-to-end task success', e2e.length ? `${e2e.filter((e) => e.ok).length}/${e2e.length}` : '-', e2e.length ? e2e.filter((e) => e.ok).length / e2e.length : null],
    ['② PII detection precision', pct(det.precision), det.precision],
    ['② PII detection recall', pct(det.recall), det.recall],
    ['② PII F1 · type accuracy', `${pct(det.f1)} · ${pct(results.length ? sum((r) => r.typeAccuracy) / results.length : 1)}`, det.f1],
    ['② Faces precision / recall', fprf ? `${pct(fprf.precision)} / ${pct(fprf.recall)}` : 'no face truth (add photos to fixtures/faces)', fprf ? fprf.f1 : null],
    ['② False alarms on the no-PII page', String(sum((r) => r.falseOnNegativePage)), sum((r) => r.falseOnNegativePage) === 0 ? 1 : 0.5],
    ['③ Redaction pixel precision', pct(pxP), pxP],
    ['③ Redaction pixel recall', pct(pxR), pxR],
    ['④ On-device time per view p50 / p95', `${client.pct(50).toFixed(0)} / ${client.pct(95).toFixed(0)} ms`, null],
    ['④ JS heap (panel+models)', `${Math.max(0, ...results.map((r) => r.heapMB)).toFixed(0)} MB`, null],
    ['④ Models', [faceInfo, florenceInfo, nerInfo].filter((m) => m.ready).map((m) => `${m.name} on ${m.backend}`).join(' · ') || '-', null],
    ['⑤ End-to-end latency p50 / p95', e2e.length ? `${(e2eT.pct(50) / 1000).toFixed(2)} / ${(e2eT.pct(95) / 1000).toFixed(2)} s` : '-', null],
    ['⑤ Server time per step (mean)', e2e.length ? `${(e2e.reduce((a, e) => a + e.serverMs, 0) / Math.max(1, e2e.reduce((a, e) => a + e.steps, 0))).toFixed(0)} ms` : '-', null]
  ]
  $('summary').innerHTML = rows.map(([a, b, v]) => `<tr><td>${a}</td><td class="${v == null ? '' : cls(v)}">${b}</td></tr>`).join('')
  const head = '<tr><th>page</th><th>P</th><th>R</th><th>px P</th><th>px R</th><th>UI</th><th>on-device ms</th><th>KB sent</th><th>task</th><th>task s</th></tr>'
  $('pages').innerHTML = head + results.map((r) => `<tr><td>${r.page}</td><td>${pct(r.detection.precision)}</td><td>${pct(r.detection.recall)}</td><td>${pct(r.pixels.precision)}</td><td>${pct(r.pixels.recall)}</td><td>${r.ui.labelled}/${r.ui.total}</td><td>${r.clientMs.toFixed(0)}</td><td>${(r.bytes / 1024).toFixed(1)}</td><td>${r.e2e ? (r.e2e.ok ? '✅' : '❌') : '-'}</td><td>${r.e2e ? (r.e2e.ms / 1000).toFixed(2) : '-'}</td></tr>`).join('')
}

function addShot(page: string, o: Observation) {
  const fig = document.createElement('figure')
  const c = document.createElement('canvas')
  c.width = o.redacted.width
  c.height = o.redacted.height
  c.getContext('2d')!.drawImage(o.redacted, 0, 0)
  const cap = document.createElement('figcaption')
  cap.textContent = `${page}: ${o.request.redactions.length} hidden (${Object.entries(o.bySource).map(([k, v]) => `${v} ${k}`).join(', ')})`
  fig.append(c, cap)
  $('shots').append(fig)
}

async function runBench() {
  const s = await settings()
  $<HTMLButtonElement>('go').disabled = true
  results = []
  $('shots').innerHTML = ''
  const reps = Math.max(1, Math.min(10, Number($<HTMLInputElement>('reps').value) || 1))
  let list: string[] = []
  try {
    list = (await (await fetch(`${s.serverUrl}/fixtures/index.json`)).json()) as string[]
  } catch {
    $('status').textContent = 'Could not reach the Eyes server for the fixtures. Start Manyaki (or npm run eyes:server).'
    $<HTMLButtonElement>('go').disabled = false
    return
  }
  const agent = new Agent({
    onObservation: () => undefined, onPlan: () => undefined, onAction: () => undefined,
    confirm: async () => true, ask: async () => null, status: (t) => { $('status').textContent = t }
  })
  let tab: chrome.tabs.Tab | undefined
  for (const page of list) {
    const url = `${s.serverUrl}/fixtures/${page}`
    for (let rep = 0; rep < reps; rep++) {
      $('status').textContent = `${page}: view ${rep + 1}/${reps}…`
      tab = await openAndWait(url, tab?.id)
      await ensureContent(tab.id!)
      const o = await observe(tab, '(benchmark)', new Vault(), [], 0, s)
      const truth = await send<Truth>(tab.id!, { type: 'truth' })
      const sc = score(o, truth)
      const clientMs = Object.values(o.timings).reduce((a, b) => a + b, 0)
      let e2e: PageResult['e2e'] = null
      if (rep === 0 && $<HTMLInputElement>('e2e').checked && truth.meta['eyes-task']) {
        await openAndWait(url, tab.id)
        $('status').textContent = `${page}: end-to-end task…`
        const r = await agent.run(truth.meta['eyes-task'], s, tab.id)
        const want = truth.meta['eyes-success'] ?? ''
        const title = (await chrome.tabs.get(tab.id!)).title ?? ''
        const ok = want.startsWith('title:') ? title === want.slice(6) : r.ok
        e2e = { task: truth.meta['eyes-task'], ok, ms: r.ms, steps: r.steps, serverMs: r.serverMs.reduce((a, b) => a + b, 0) }
      }
      if (rep === 0) addShot(page, o)
      results.push({ page, ...sc, timings: o.timings, clientMs, bytes: o.bytes, heapMB: heap(), e2e })
      render()
    }
  }
  if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => undefined)
  $('status').textContent = `Done: ${results.length} views on ${list.length} pages.`
  $<HTMLButtonElement>('go').disabled = false
  $<HTMLButtonElement>('dl').disabled = false
}

$('go').addEventListener('click', () => void runBench())
$('dl').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ at: new Date().toISOString(), ua: navigator.userAgent, models: [faceInfo, florenceInfo, nerInfo], results }, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `manyaki-eyes-bench-${Date.now()}.json`
  a.click()
})
