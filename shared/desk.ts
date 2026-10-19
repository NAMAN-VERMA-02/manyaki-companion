import { findPII, replaceSpans } from '../eyes/shared/pii'
import type { Vault } from '../eyes/shared/vault'
import { matchScore } from '../electron/resolve'

// Pure rules for Manyaki's desktop hands (no Electron, so unit-tested): which window a request means,
// which windows are too private to read, how what she reads is redacted, and which actions need an OK.

export interface Win { hwnd: number; title: string; pid: number; app: string; x: number; y: number; w: number; h: number; min: boolean; max: boolean; active: boolean }
export interface Ctl { id: string; type: string; name: string; x: number; y: number; w: number; h: number; enabled: boolean; focus: boolean; password: boolean; value: string | null; toggle: string | null; act: boolean; aid: string | null }
export interface OcrWord { t: string; x: number; w: number }
export interface OcrLine { text: string; x: number; y: number; w: number; h: number; words: OcrWord[] }

/** Apps and pages she never reads: password managers, banking, private browsing, sign-in prompts. */
const PRIVATE = /\b(1password|bitwarden|keepass(xc)?|lastpass|dashlane|keeper|credential manager|windows security|netbanking|net banking|internet banking|bank of|sbi online|hdfc|icici|axis bank|kotak|paypal|razorpay|paytm|phonepe|gpay|google pay|inprivate|incognito|private browsing|sign in to your account|password)\b/i

export const isPrivateWindow = (app: string, title: string) => PRIVATE.test(`${app} ${title}`)

/** The window a request like "close the chrome window with youtube" means, or null. */
export function pickWindow(wins: Win[], query: string): Win | null {
  const q = query.replace(/\b(the|my|a|window|windows|app|tab|one|wala|wali|vala|with|that|which|has|is|open|opened|playing|showing|all)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!q || /^(this|current|active|it|ye|yeh|is)$/i.test(q)) return wins.find((w) => w.active) ?? null
  const want = q.toLowerCase().split(' ').filter((x) => x.length > 1)
  let best: { w: Win; s: number } | null = null
  for (const w of wins) {
    const hay = `${w.app} ${w.title}`.toLowerCase()
    const hits = want.filter((x) => hay.includes(x)).length
    const words = want.length ? hits / want.length : 0
    const s = Math.max(matchScore(q, w.title), matchScore(q, w.app) + 5, words >= 0.5 ? 40 + 40 * words : 0)
    if (s >= 40 && (!best || s > best.s || (s === best.s && w.active))) best = { w, s }
  }
  return best?.w ?? null
}

/** Text with private details hidden: tokens (so she can type them back locally) or plain masks. */
export function hide(text: string, vault: Vault | null, shield: boolean): string {
  if (!shield || !text) return text
  const spans = findPII(text)
  if (!spans.length) return text
  return vault ? vault.tokenize(text, spans).text : replaceSpans(text, spans, (s) => `[${s.type.toLowerCase()}]`)
}

/** Window list for the brain: titles redacted, private windows shown only by app. */
export function describeWindows(wins: Win[], vault: Vault | null, shield: boolean): string {
  return wins.map((w, i) => {
    const title = isPrivateWindow(w.app, w.title) ? '(private window)' : hide(w.title, vault, shield).slice(0, 90)
    return `${i + 1}. ${w.app}: ${title}${w.active ? ' [active]' : ''}${w.min ? ' [minimised]' : ''}${w.max ? ' [maximised]' : ''}`
  }).join('\n')
}

/** An app's controls as compact lines (like the browser agent's elements), with values redacted. */
export function describeControls(ctls: Ctl[], vault: Vault | null, shield: boolean, max = 120): string {
  const lines: string[] = []
  for (const c of ctls) {
    if (lines.length >= max) break
    if (!c.name && !c.value && !c.act) continue
    const name = hide(c.name, vault, shield).slice(0, 80)
    let val = ''
    if (c.password) val = ' value=[hidden password]'
    else if (c.value) val = ` value=${JSON.stringify(hide(c.value, vault, shield).slice(0, 80))}`
    const flags = [c.focus ? 'focused' : '', !c.enabled ? 'disabled' : '', c.toggle ? c.toggle : ''].filter(Boolean).join(' ')
    lines.push(`${c.id} ${c.type} ${JSON.stringify(name)}${val}${flags ? ` (${flags})` : ''}`)
  }
  return lines.join('\n')
}

/** Screen text with private spans hidden, plus the pixel boxes to black out (word-accurate). */
export function redactOcr(lines: OcrLine[], vault: Vault | null, shield: boolean): { text: string[]; boxes: number[] } {
  const text: string[] = []
  const boxes: number[] = []
  for (const l of lines) {
    if (!shield) { text.push(l.text); continue }
    const spans = findPII(l.text)
    if (!spans.length) { text.push(l.text); continue }
    text.push(vault ? vault.tokenize(l.text, spans).text : replaceSpans(l.text, spans, (s) => `[${s.type.toLowerCase()}]`))
    // Map each span to the words it covers (OCR line text is the words joined by spaces).
    let at = 0
    const pos = l.words.map((w) => { const p = l.text.indexOf(w.t, at); at = p >= 0 ? p + w.t.length : at; return p })
    for (const s of spans) {
      const hit = l.words.filter((w, i) => pos[i] >= 0 && pos[i] < s.end && pos[i] + w.t.length > s.start)
      if (hit.length) {
        const x0 = Math.min(...hit.map((w) => w.x))
        const x1 = Math.max(...hit.map((w) => w.x + w.w))
        boxes.push(x0 - 2, l.y - 2, x1 - x0 + 4, l.h + 4)
      } else boxes.push(l.x, l.y, l.w, l.h)
    }
  }
  return { text, boxes }
}

/** Where to click to hit some visible text ("click Submit"), from OCR words. */
export function findText(lines: OcrLine[], target: string): { x: number; y: number; text: string } | null {
  const want = target.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!want) return null
  let best: { x: number; y: number; text: string; score: number } | null = null
  for (const l of lines) {
    const lt = l.text.toLowerCase()
    const i = lt.indexOf(want)
    if (i < 0) continue
    // Prefer short lines that are mostly the target (a button), then earlier on screen.
    const score = want.length / lt.length
    let at = 0
    const ws = l.words.map((w) => { const p = lt.indexOf(w.t.toLowerCase(), at); at = p >= 0 ? p + w.t.length : at; return { w, p } })
    const covered = ws.filter(({ w, p }) => p >= 0 && p < i + want.length && p + w.t.length > i)
    const x0 = covered.length ? Math.min(...covered.map((c) => c.w.x)) : l.x
    const x1 = covered.length ? Math.max(...covered.map((c) => c.w.x + c.w.w)) : l.x + l.w
    if (!best || score > best.score) best = { x: Math.round((x0 + x1) / 2), y: Math.round(l.y + l.h / 2), text: l.text, score }
  }
  return best ? { x: best.x, y: best.y, text: best.text } : null
}

const TERMINAL = /\b(powershell|pwsh|cmd|command prompt|windows terminal|terminal|bash|wsl|ubuntu|git bash|conhost|run)\b/i

/**
 * Why an action needs the user's OK (shown as a native dialog), or null. Terminals and the Run box can
 * execute anything, so typing there is confirmed; so is closing a window with unsaved changes.
 */
export function riskOf(action: { kind: 'type' | 'keys' | 'close' | 'setvalue'; text?: string }, win: Win | null): string | null {
  const where = win ? `${win.app} ${win.title}` : ''
  if (action.kind === 'keys' && /\bwin\s*\+\s*r\b/i.test(action.text ?? '')) return 'open the Run box (it can start any program)'
  if ((action.kind === 'type' || action.kind === 'setvalue') && TERMINAL.test(where)) return `type into ${win?.app ?? 'a terminal'} (commands there run on your PC): “${(action.text ?? '').slice(0, 80)}”`
  if (action.kind === 'keys' && /\benter\b/i.test(action.text ?? '') && TERMINAL.test(where)) return `press Enter in ${win?.app ?? 'a terminal'} (it runs the command)`
  if (action.kind === 'close' && win && /(^\*|\*\s|●|•|unsaved|modified)/i.test(win.title)) return `close “${win.title.slice(0, 60)}” (it may have unsaved changes)`
  return null
}

/** Something on screen worth offering help with: a compiler/runtime error in a work app. */
export function errorOnScreen(lines: string[]): string | null {
  for (const l of lines) {
    if (/\b(Traceback \(most recent call last\)|[A-Z][a-zA-Z]+(Error|Exception)\b[:(]|error (TS|CS|C)\d{3,5}|Segmentation fault|npm ERR!|FAILED|fatal:|Uncaught |Cannot find module|is not defined|undefined reference)/.test(l)) return l.slice(0, 160)
  }
  return null
}
