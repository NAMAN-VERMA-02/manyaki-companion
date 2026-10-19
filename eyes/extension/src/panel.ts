import type { AgentAction, StepResponse } from '../../shared/protocol'
import { Timer } from '../../shared/metrics'
import { Agent, event, type AgentSettings, type AgentUI } from './agent'
import { observe, send, type Observation } from './pipeline'
import { faceInfo, florenceInfo, hasWebGPU, loadFaces, nerInfo } from './vision'
import { Vault } from '../../shared/vault'

// The side panel (Chrome) / sidebar (Firefox): task box, the redacted view the server gets, the step log,
// live metrics and settings. It also long-polls Manyaki for tasks given by voice.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const DEFAULTS: AgentSettings = { serverUrl: 'http://127.0.0.1:47821', pairing: '', faces: true, deep: false, sendImage: true, maxSteps: 12 }
let settings: AgentSettings = { ...DEFAULTS }
let inbox = true
let pending: { resolve: (v: string | boolean | null) => void; kind: 'confirm' | 'ask' } | null = null
let lastObs: Observation | null = null
let lastPlan: StepResponse | null = null
const timers: Record<string, Timer> = {}
const tick = (k: string, ms: number) => (timers[k] ??= new Timer()).add(ms)
const totals = { redactions: 0, clientLeaks: 0, serverLeaks: 0, bytes: 0, steps: 0 }

async function loadSettings() {
  const s = (await chrome.storage.local.get(['settings', 'inbox'])) as { settings?: Partial<AgentSettings>; inbox?: boolean }
  settings = { ...DEFAULTS, ...s.settings }
  inbox = s.inbox ?? true
  $<HTMLInputElement>('server').value = settings.serverUrl
  $<HTMLInputElement>('pairing').value = settings.pairing
  $<HTMLInputElement>('faces').checked = settings.faces
  $<HTMLInputElement>('deep').checked = settings.deep
  $<HTMLInputElement>('sendImage').checked = settings.sendImage
  $<HTMLInputElement>('maxSteps').value = String(settings.maxSteps)
  $<HTMLInputElement>('inbox').checked = inbox
}

async function saveSettings() {
  settings = {
    serverUrl: $<HTMLInputElement>('server').value.trim() || DEFAULTS.serverUrl,
    pairing: $<HTMLInputElement>('pairing').value.trim(),
    faces: $<HTMLInputElement>('faces').checked,
    deep: $<HTMLInputElement>('deep').checked,
    sendImage: $<HTMLInputElement>('sendImage').checked,
    maxSteps: Math.max(1, Math.min(30, Number($<HTMLInputElement>('maxSteps').value) || 12))
  }
  inbox = $<HTMLInputElement>('inbox').checked
  await chrome.storage.local.set({ settings, inbox })
  void checkServer()
}

// ---------- server connection ----------
let connected = false
async function checkServer() {
  const conn = $('conn')
  try {
    const r = await fetch(`${settings.serverUrl}/health`, { signal: AbortSignal.timeout(2500) })
    const j = (await r.json()) as { planner: string; vision: boolean; auth: boolean }
    connected = true
    conn.className = 'sub ok'
    conn.textContent = `server ok · planner ${j.planner}${j.vision ? ' (sees images)' : ''}${j.auth && !settings.pairing ? ' · needs pairing code' : ''}`
  } catch {
    connected = false
    conn.className = 'sub bad'
    conn.textContent = 'server not reachable: start Manyaki (or npm run eyes:server)'
  }
}

// ---------- rendering ----------
function draw(o: Observation) {
  const c = $<HTMLCanvasElement>('view')
  const src = $<HTMLInputElement>('show-original').checked ? o.original : o.redacted
  c.width = src.width
  c.height = src.height
  c.getContext('2d')!.drawImage(src, 0, 0)
  $('shot-empty').classList.add('hidden')
  const byType = new Map<string, number>()
  for (const r of o.request.redactions) byType.set(r.type, (byType.get(r.type) ?? 0) + 1)
  $('chips').innerHTML = ''
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) {
    const s = document.createElement('span')
    s.className = 'chip'
    s.textContent = `${t.toLowerCase().replace('_', ' ')} ×${n}`
    $('chips').append(s)
  }
  if (o.clientLeaks) {
    const s = document.createElement('span')
    s.className = 'chip warn'
    s.textContent = `leak guard caught ${o.clientLeaks}`
    $('chips').append(s)
  }
  $('counts').textContent = `${o.request.elements.length} elements · ${o.request.redactions.length} hidden · ${(o.bytes / 1024).toFixed(1)} KB sent`
  if ($<HTMLInputElement>('pv').checked) void privacyView(o)
}

async function privacyView(o: Observation | null) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) return
  const boxes = o && $<HTMLInputElement>('pv').checked
    ? o.marks.map((m) => ({ box: m.box, label: m.type === 'FACE' ? 'FACE' : m.token.replace(/^\[\[|\]\]$/g, ''), kind: (m.type === 'FACE' ? 'mosaic' : 'black') as 'black' | 'mosaic' }))
    : null
  await send(tab.id, { type: 'privacy-view', boxes }).catch(() => undefined)
}

function logLine(html: string, cls = '') {
  const li = document.createElement('li')
  li.className = cls
  li.innerHTML = html
  $('log').append(li)
  $('log').scrollTop = $('log').scrollHeight
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const fmtAction = (a: AgentAction) => esc(JSON.stringify(a).replace(/^\{"type":"(\w+)",?/, '$1 ').replace(/\}$/, ''))

function renderMetrics() {
  const rows: [string, string][] = []
  const sec = (t: string) => rows.push([`§${t}`, ''])
  const ms = (k: string, label: string) => { const t = timers[k]; if (t?.count) rows.push([label, `${t.pct(50).toFixed(0)} / ${t.pct(95).toFixed(0)} ms`]) }
  sec('latency p50 / p95')
  ms('perceive', 'DOM perception')
  ms('capture', 'screenshot')
  ms('faces', 'face detection')
  ms('ner', 'names (NER)')
  ms('ocr', 'OCR (Florence-2)')
  ms('caption', 'caption (Florence-2)')
  ms('redact', 'redaction')
  ms('guard', 'leak guard')
  ms('client', 'all on-device work')
  ms('server', 'server round trip')
  ms('step', 'whole step')
  sec('privacy')
  rows.push(['values hidden (session)', String(totals.redactions)])
  if (lastObs) for (const [k, v] of Object.entries(lastObs.bySource)) rows.push([`  last step · by ${k}`, String(v)])
  rows.push(['leaks caught · client / server', `${totals.clientLeaks} / ${totals.serverLeaks}`])
  rows.push(['avg payload', totals.steps ? `${(totals.bytes / totals.steps / 1024).toFixed(1)} KB` : '-'])
  sec('resources')
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  if (mem) rows.push(['JS heap', `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`])
  rows.push(['planner', lastPlan?.model ?? '-'])
  const t = $<HTMLTableElement>('metrics')
  t.innerHTML = rows.map(([a, b]) => (a.startsWith('§') ? `<tr class="sec"><td colspan="2">${esc(a.slice(1))}</td></tr>` : `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`)).join('')
  const models = [faceInfo, ...(settings.deep ? [florenceInfo, nerInfo] : [])]
    .map((m) => `${m.name}: ${m.error ? `failed (${m.error.slice(0, 60)})` : m.ready ? `${m.backend}, loaded in ${(m.loadMs / 1000).toFixed(1)} s` : 'not loaded yet'}`)
  $('models').textContent = models.join(' · ')
}

function record(o: Observation) {
  for (const [k, v] of Object.entries(o.timings)) tick(k, v)
  tick('client', Object.values(o.timings).reduce((a, b) => a + b, 0))
  totals.redactions += o.request.redactions.length
  totals.clientLeaks += o.clientLeaks
  totals.bytes += o.bytes
  totals.steps++
}

// ---------- dialog for confirmations / questions ----------
function dialog(kind: 'confirm' | 'ask', q: string): Promise<string | boolean | null> {
  $('dialog').classList.remove('hidden')
  $('dialog-q').textContent = q
  $('dialog-in').classList.toggle('hidden', kind !== 'ask')
  $<HTMLInputElement>('dialog-in').value = ''
  $('dialog-yes').textContent = kind === 'ask' ? 'Answer' : 'Allow'
  if (kind === 'ask') $<HTMLInputElement>('dialog-in').focus()
  return new Promise((resolve) => { pending = { resolve, kind } })
}
function closeDialog(v: string | boolean | null) {
  $('dialog').classList.add('hidden')
  const p = pending
  pending = null
  p?.resolve(v)
}

const ui: AgentUI = {
  onObservation(o) { lastObs = o; record(o); draw(o); renderMetrics() },
  onPlan(r, o) {
    lastPlan = r
    tick('server', r.ms)
    totals.serverLeaks += r.leaks ?? 0
    tick('step', Object.values(o.timings).reduce((a, b) => a + b, 0) + r.ms)
    logLine(`<span class="thought">${esc(r.thought || '…')}</span> <span class="hint">(${esc(r.model)}, ${r.ms} ms)</span>`)
    if (r.error) logLine(esc(r.error), 'bad')
    renderMetrics()
  },
  onAction(a, ok, note) { logLine(`<span class="act">${fmtAction(a)}</span>${ok ? '' : ` <span class="bad">✗ ${esc(note ?? '')}</span>`}`) },
  confirm: async (q) => (await dialog('confirm', q)) === true,
  ask: async (q) => { const v = await dialog('ask', q); return typeof v === 'string' ? v : null },
  status: (t) => { $('status').textContent = t }
}

const agent = new Agent(ui)

async function run(task: string) {
  if (agent.running || !task.trim()) return
  await saveSettings()
  $<HTMLButtonElement>('run').disabled = true
  $<HTMLButtonElement>('stop').disabled = false
  $('log').innerHTML = ''
  const r = await agent.run(task, settings)
  $('status').textContent = `${r.ok ? '✅' : '⚠️'} ${r.summary} (${r.steps} step${r.steps === 1 ? '' : 's'}, ${(r.ms / 1000).toFixed(1)} s)`
  logLine(`<b>${esc(r.ok ? 'Done' : 'Stopped')}:</b> ${esc(r.summary)}`, r.ok ? '' : 'bad')
  $<HTMLButtonElement>('run').disabled = false
  $<HTMLButtonElement>('stop').disabled = true
}

async function lookOnly() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id || !/^https?:|^file:/.test(tab.url ?? '')) { $('status').textContent = 'Open a normal web page first.'; return }
  await saveSettings()
  $('status').textContent = 'looking (on device)…'
  try {
    const o = await observe(tab, '(look only)', new Vault(), [], 0, settings)
    ui.onObservation(o)
    $('status').textContent = `Found ${o.request.redactions.length} private item(s); nothing was sent.`
  } catch (e) {
    $('status').textContent = `Couldn't look: ${(e as Error).message}`
  }
}

// ---------- tasks from Manyaki ----------
async function pollInbox() {
  for (;;) {
    if (!inbox || !connected || agent.running) { await new Promise((r) => setTimeout(r, 3000)); continue }
    try {
      const res = await fetch(`${settings.serverUrl}/v1/tasks/next`, { headers: settings.pairing ? { authorization: `Bearer ${settings.pairing}` } : {}, signal: AbortSignal.timeout(30000) })
      if (res.status === 401) { $('conn').textContent = 'pairing code wrong: copy it from Manyaki Home → Eyes'; await new Promise((r) => setTimeout(r, 8000)); continue }
      const j = (await res.json()) as { task: string | null }
      if (j.task) {
        $<HTMLTextAreaElement>('task').value = j.task
        void run(j.task)
      }
    } catch {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

async function init() {
  await loadSettings()
  await checkServer()
  setInterval(checkServer, 15000)
  for (const id of ['server', 'pairing', 'faces', 'deep', 'sendImage', 'maxSteps', 'inbox']) $(id).addEventListener('change', () => void saveSettings())
  $('task-form').addEventListener('submit', (e) => { e.preventDefault(); void run($<HTMLTextAreaElement>('task').value) })
  $('task').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' && ((e as KeyboardEvent).ctrlKey || (e as KeyboardEvent).metaKey)) { e.preventDefault(); void run($<HTMLTextAreaElement>('task').value) } })
  $('stop').addEventListener('click', () => { agent.stop(); closeDialog(null) })
  $('look').addEventListener('click', () => void lookOnly())
  $('show-original').addEventListener('change', () => lastObs && draw(lastObs))
  $('pv').addEventListener('change', () => void privacyView(lastObs))
  $('dialog-yes').addEventListener('click', () => closeDialog(pending?.kind === 'ask' ? $<HTMLInputElement>('dialog-in').value : true))
  $('dialog-no').addEventListener('click', () => closeDialog(pending?.kind === 'ask' ? null : false))
  $('bench').addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('bench.html') }))
  renderMetrics()
  // Warm the face model in the background so the first step is fast.
  if (settings.faces) void loadFaces().then(renderMetrics)
  void hasWebGPU().then((g) => { if (!g && settings.deep) $('status').textContent = 'No WebGPU here: deep vision will run on WASM (slower).' })
  event(settings, { kind: 'connected' })
  void pollInbox()
}

void init()
