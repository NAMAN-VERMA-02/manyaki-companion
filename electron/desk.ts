import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dialog, screen } from 'electron'
import { Vault } from '../eyes/shared/vault'
import { describeControls, describeWindows, errorOnScreen, findText, hide, isPrivateWindow, pickWindow, redactOcr, riskOf, type Ctl, type OcrLine, type Win } from '../shared/desk'
import type { Glance, WindowOp } from '../shared/types'

// Manyaki's hands and eyes on the desktop. A long-running PowerShell helper (assets/desk/host.ps1) does
// the Win32 / UI Automation / OCR work; this side decides what she may see and do:
// - everything she reads goes through the privacy shield (private details found on this PC and hidden);
// - a task vault turns hidden values into tokens, so she can type "[[EMAIL_1]]" and the real value is
//   filled in here, never by the model;
// - anything that can run commands or lose work asks first, with a native dialog.

type Req = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

let host: ChildProcessWithoutNullStreams | null = null
let ready: Promise<void> | null = null
let seq = 0
const pending = new Map<number, Req>()
let scriptPath = ''
let log: (level: string, msg: string) => void = () => undefined
// Her BrowserWindows belong to the main process.
const ownPid = process.pid

export function initDesk(opts: { script: string; log: (level: string, msg: string) => void }) {
  scriptPath = opts.script
  log = opts.log
}

function start(): Promise<void> {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true })
    host = p
    const boot = setTimeout(() => reject(new Error('desktop helper did not start')), 20000)
    createInterface({ input: p.stdout }).on('line', (line) => {
      let m: { id: number; ok: boolean; result?: unknown; error?: string }
      try { m = JSON.parse(line) } catch { return }
      if (m.id === 0) { clearTimeout(boot); resolve(); return }
      const r = pending.get(m.id)
      if (!r) return
      pending.delete(m.id)
      clearTimeout(r.timer)
      if (m.ok) r.resolve(m.result)
      else r.reject(new Error(m.error ?? 'desktop helper error'))
    })
    p.stderr.on('data', (d) => log('warn', `desk: ${String(d).trim().slice(0, 300)}`))
    p.on('exit', (code) => {
      log('warn', `desktop helper exited (${code})`)
      host = null
      ready = null
      for (const r of pending.values()) { clearTimeout(r.timer); r.reject(new Error('desktop helper stopped')) }
      pending.clear()
    })
  })
  ready.catch(() => { ready = null })
  return ready
}

async function call<T>(op: string, args: Record<string, unknown> = {}, ms = 15000): Promise<T> {
  await start()
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${op} timed out`)) }, ms)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    host!.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
  })
}

export function stopDesk() { host?.stdin.end(); host?.kill(); host = null; ready = null }
export const warmDesk = () => start().catch((e: Error) => log('warn', `desk: ${e.message}`))

// ---------------- task vault ----------------
// One vault per task (renewed after 10 quiet minutes) so tokens stay stable while she works.
let vault = new Vault()
let vaultAt = 0
const taskVault = () => {
  if (Date.now() - vaultAt > 10 * 60000) vault = new Vault()
  vaultAt = Date.now()
  return vault
}

let shieldOn = true
export function setShield(on: boolean) { shieldOn = on }

// ---------------- windows ----------------

async function windows(): Promise<Win[]> {
  const all = await call<Win[]>('windows')
  // Not her own windows (overlay, Home), and not empty shells.
  return all.filter((w) => w.pid !== ownPid && !/^(electron|manyaki)$/i.test(w.app) && w.title.trim())
}

export async function listWindows(): Promise<string> {
  const ws = await windows()
  return ws.length ? describeWindows(ws, taskVault(), shieldOn) : 'no open windows'
}

async function confirm(message: string): Promise<boolean> {
  const r = await dialog.showMessageBox({ type: 'question', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Manyaki', message: 'Manyaki wants to:', detail: message, noLink: true })
  return r.response === 0
}

export async function windowAction(query: string, op: WindowOp): Promise<string> {
  const ws = await windows()
  const w = pickWindow(ws, query)
  if (!w) return `no window matches "${query}". Open windows:\n${describeWindows(ws.slice(0, 12), taskVault(), shieldOn)}`
  const name = `${w.app} (${isPrivateWindow(w.app, w.title) ? 'private window' : hide(w.title, taskVault(), shieldOn).slice(0, 60)})`
  switch (op) {
    case 'focus': await call('focus', { hwnd: w.hwnd }); return `switched to ${name}`
    case 'close': {
      const risk = riskOf({ kind: 'close' }, w)
      if (risk && !(await confirm(risk))) return 'the user said no'
      await call('close', { hwnd: w.hwnd })
      return `asked ${name} to close (the app may ask to save first)`
    }
    case 'minimize': await call('show', { hwnd: w.hwnd, cmd: 6 }); return `minimised ${name}`
    case 'maximize': await call('show', { hwnd: w.hwnd, cmd: 3 }); return `maximised ${name}`
    case 'restore': await call('show', { hwnd: w.hwnd, cmd: 9 }); return `restored ${name}`
    case 'center': await call('snap', { hwnd: w.hwnd, side: 'center' }); return `centred ${name}`
    default: await call('snap', { hwnd: w.hwnd, side: op.replace('snap_', '') }); await call('focus', { hwnd: w.hwnd }); return `snapped ${name} to the ${op.replace('snap_', '')}`
  }
}

/** Closes every window that matches (e.g. "all chrome windows"). */
export async function closeAll(query: string): Promise<string> {
  const ws = (await windows()).filter((w) => pickWindow([w], query))
  if (!ws.length) return `no windows match "${query}"`
  for (const w of ws) {
    const risk = riskOf({ kind: 'close' }, w)
    if (risk && !(await confirm(risk))) continue
    await call('close', { hwnd: w.hwnd })
  }
  return `asked ${ws.length} window(s) to close`
}

// ---------------- an app's controls ----------------

let lastTree: { hwnd: number; ctls: Ctl[]; win: Win | null } = { hwnd: 0, ctls: [], win: null }

export async function readApp(query?: string): Promise<string> {
  const ws = await windows()
  const w = query ? pickWindow(ws, query) : ws.find((x) => x.active) ?? null
  if (!w) return query ? `no window matches "${query}"` : 'no app is in front (it may be me)'
  if (isPrivateWindow(w.app, w.title) && shieldOn) return `${w.app} is a private window (passwords/banking); I don't read it`
  if (!w.active) { await call('focus', { hwnd: w.hwnd }); await new Promise((r) => setTimeout(r, 250)) }
  const ctls = await call<Ctl[]>('tree', { hwnd: w.hwnd, max: 260 }, 20000)
  lastTree = { hwnd: w.hwnd, ctls, win: w }
  const title = hide(w.title, taskVault(), shieldOn)
  return `${w.app}: ${title}\nControls (use the id to press or type):\n${describeControls(ctls, taskVault(), shieldOn)}`
}

const ctlById = (id: string) => lastTree.ctls.find((c) => c.id === id)

export async function pressControl(id: string): Promise<string> {
  const c = ctlById(id)
  if (!c) return `no control ${id}: read the app first`
  const how = await call<string>('invoke', { id })
  return `${how} ${c.type} "${hide(c.name, taskVault(), shieldOn).slice(0, 50)}"`
}

/** Types into a control, restoring hidden values ([[EMAIL_1]] → the real address) here, locally. */
export async function typeInto(id: string, text: string): Promise<string> {
  const c = ctlById(id)
  if (!c) return `no control ${id}: read the app first`
  const risk = riskOf({ kind: 'setvalue', text }, lastTree.win)
  if (risk && !(await confirm(risk))) return 'the user said no'
  const how = await call<string>('setvalue', { id, text: taskVault().rehydrate(text) })
  return `${how} into ${c.type} "${hide(c.name, taskVault(), shieldOn).slice(0, 50)}"`
}

async function activeWin(): Promise<Win | null> {
  return (await windows()).find((w) => w.active) ?? null
}

export async function typeText(text: string): Promise<string> {
  const risk = riskOf({ kind: 'type', text }, await activeWin())
  if (risk && !(await confirm(risk))) return 'the user said no'
  await call('type', { text: taskVault().rehydrate(text).slice(0, 4000) }, 60000)
  return 'typed'
}

export async function pressKeys(combo: string): Promise<string> {
  const risk = riskOf({ kind: 'keys', text: combo }, await activeWin())
  if (risk && !(await confirm(risk))) return 'the user said no'
  await call('keys', { combo })
  return `pressed ${combo}`
}

/** Scrolls the page in the window in front (at its centre, not wherever the mouse happens to be). */
export async function scroll(direction: 'up' | 'down' | 'top' | 'bottom', amount = 3): Promise<string> {
  const w = await activeWin()
  const x = w ? Math.round(w.x + w.w / 2) : -1
  const y = w ? Math.round(w.y + w.h * 0.6) : -1
  lastKey = '' // what's visible changes: the next look must be fresh
  if (direction === 'top' || direction === 'bottom') {
    // Home/End only work once the page has focus; a click in the middle of the page gives it focus.
    if (w) await call('click', { x, y, button: 'left', double: false }).catch(() => undefined)
    await call('keys', { combo: direction === 'top' ? 'ctrl+home' : 'ctrl+end' })
    return `went to the ${direction} of the page`
  }
  await call('scroll', { x, y, clicks: (direction === 'up' ? 1 : -1) * Math.max(1, Math.min(15, Math.round(amount))) })
  return `scrolled ${direction}`
}

// ---------------- seeing ----------------

function primary() {
  const d = screen.getPrimaryDisplay()
  const s = d.scaleFactor
  return { x: Math.round(d.bounds.x * s), y: Math.round(d.bounds.y * s), w: Math.round(d.bounds.width * s), h: Math.round(d.bounds.height * s) }
}

async function ocrRegion(r: { x: number; y: number; w: number; h: number }): Promise<OcrLine[]> {
  const res = await call<{ lines: OcrLine[] }>('ocr', r, 30000)
  return res.lines ?? []
}

/** Clicks the visible text that matches ("click Submit", "open the Settings tab"). */
export async function clickText(target: string, double = false): Promise<string> {
  const lines = await ocrRegion(primary())
  const hit = findText(lines, target)
  if (!hit) return `I can't see "${target}" on the screen`
  await call('click', { x: hit.x, y: hit.y, button: 'left', double })
  return `clicked "${hide(hit.text, taskVault(), shieldOn).slice(0, 60)}"`
}

/**
 * One screenshot for a vision model: with the shield on, private text is found by OCR on this PC and
 * blacked out word by word before the image is encoded. Private windows are refused.
 */
export async function screenshotForModel(): Promise<{ image: string; hidden: number } | { error: string }> {
  const w = await activeWin()
  if (w && isPrivateWindow(w.app, w.title) && shieldOn) return { error: `${w.app} is a private window; I won't send a picture of it` }
  const lines = await ocrRegion(primary())
  const { boxes } = redactOcr(lines, null, shieldOn)
  const image = await call<string>('redacted', { boxes, maxW: 1280, quality: 72 })
  await call('forget')
  return { image, hidden: boxes.length / 4 }
}

// ---------------- screen sense: always aware, nothing stored ----------------

let glance: Glance | null = null
let lastKey = ''
let lastAt = 0
let sensing = false

/**
 * Reads the window in front with on-device OCR when it changes (and every ~30 s), redacts it, and keeps
 * only the latest glance in memory. The pixels are discarded at once; nothing goes to disk or the cloud.
 */
export async function senseOnce(opts: { idleSeconds: number; fullscreen: boolean }): Promise<Glance | null> {
  if (sensing || opts.idleSeconds > 120 || opts.fullscreen) return glance
  sensing = true
  try {
    const w = await activeWin()
    if (!w) return glance
    const key = `${w.hwnd}|${w.title}`
    if (key === lastKey && Date.now() - lastAt < 30000) return glance
    lastKey = key
    lastAt = Date.now()
    if (isPrivateWindow(w.app, w.title)) {
      glance = { app: w.app, title: '(private window)', lines: [], error: null, at: Date.now(), private: true }
      return glance
    }
    const scr = primary()
    const r = { x: Math.max(scr.x, w.x), y: Math.max(scr.y, w.y), w: 0, h: 0 }
    r.w = Math.min(scr.x + scr.w, w.x + w.w) - r.x
    r.h = Math.min(scr.y + scr.h, w.y + w.h) - r.y
    if (r.w < 40 || r.h < 40) return glance
    const lines = await ocrRegion(r)
    await call('forget')
    // Glances are always redacted with masks (not tokens): they're for awareness, not for typing.
    const { text } = redactOcr(lines, null, true)
    const kept = text.map((t) => t.trim()).filter((t) => t.length > 1).slice(0, 90)
    glance = { app: w.app, title: hide(w.title, null, true).slice(0, 120), lines: kept, error: errorOnScreen(kept), at: Date.now(), private: false }
    return glance
  } catch (e) {
    log('warn', `sense: ${(e as Error).message}`)
    return glance
  } finally {
    sensing = false
  }
}

export const currentGlance = () => glance
export function clearGlance() { glance = null; lastKey = '' }

/** What's on screen right now, for the brain (latest glance; refreshed if it's stale). */
export async function seeScreen(): Promise<string> {
  // Read fresh (≈1 s) unless the last look is only a moment old: she must talk about what's there now.
  if (!glance || Date.now() - glance.at > 2500) { lastKey = ''; await senseOnce({ idleSeconds: 0, fullscreen: false }) }
  const g = glance
  if (!g) return 'I can\'t see the screen right now'
  if (g.private) return `${g.app} is open (a private window, so I don't read it)`
  return `In front: ${g.app}: ${g.title}\nVisible text, top to bottom (private details masked):\n${g.lines.join('\n')}`
}
