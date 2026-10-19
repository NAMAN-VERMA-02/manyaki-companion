import type { AgentAction, Box, ScreenElement, StepRequest } from '../shared/protocol'

// Rule planner: works with no model at all (offline demo, or the model is down).
//
// Explainable plans for common tasks. Multi-part tasks ("choose express delivery and continue to
// payment") run one part per action, in order. Targets are matched by word overlap with labels, and
// "the post about X" picks the matching control nearest below the text that mentions X.

const norm = (s: string) => s.toLowerCase().replace(/\[\[[A-Z_]+_\d+\]\]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
const STOP = new Set(['the', 'a', 'an', 'on', 'to', 'of', 'my', 'this', 'that', 'button', 'link', 'option', 'tab', 'please', 'for', 'me', 'it'])
const words = (s: string) => norm(s).split(' ').filter((w) => w && !STOP.has(w))

const CLICKABLE = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch']

/** Best element for some words: share of the words found in its label (prefix matches count). */
function best(els: ScreenElement[], target: string, roles?: string[]): { el: ScreenElement; score: number } | null {
  const want = words(target)
  if (!want.length) return null
  let top: { el: ScreenElement; score: number } | null = null
  for (const el of els) {
    if (el.disabled || (roles && !roles.includes(el.role))) continue
    const have = words(el.label)
    if (!have.length) continue
    const hit = want.filter((w) => have.some((h) => h === w || (w.length > 3 && (h.startsWith(w) || w.startsWith(h))))).length
    if (hit / want.length < 0.5) continue
    // Ties go to labels that are mostly the target (a "Like" button over a paragraph mentioning likes).
    const score = hit / want.length - Math.min(0.09, Math.max(0, have.length - want.length) * 0.01)
    if (!top || score > top.score) top = { el, score }
  }
  return top
}

/** The candidate nearest below (or beside) the place where `anchor` is mentioned. */
function nearest(req: StepRequest, candidates: ScreenElement[], anchor: string): ScreenElement | undefined {
  const a = words(anchor)
  const spots: Box[] = []
  req.text.forEach((t, i) => {
    const b = req.textBoxes?.[i]
    if (b && a.some((w) => norm(t).includes(w))) spots.push(b)
  })
  for (const e of req.elements) if (a.some((w) => norm(e.label).includes(w))) spots.push(e.box)
  if (!spots.length) return undefined
  let pick: ScreenElement | undefined
  let bestD = Infinity
  for (const c of candidates) {
    for (const s of spots) {
      const dy = c.box.y - (s.y + s.h)
      const dx = Math.abs(c.box.x - s.x)
      const d = (dy < -s.h ? 1e4 : Math.abs(dy)) + dx * 0.3 // controls usually sit below what they act on
      if (d < bestD) { bestD = d; pick = c }
    }
  }
  return pick
}

export type Plan = { thought: string; actions: AgentAction[] }

/** One part of a task -> one action, or null if the rules can't handle it. */
function planPart(part: string, req: StepRequest): Plan | null {
  const els = req.elements
  const fields = els.filter((e) => ['textbox', 'searchbox', 'password', 'textarea'].includes(e.role) && !e.disabled)

  const search = /\b(?:search(?: for)?|find|look up|dhundo|khojo)\s+(.+)/i.exec(part)
  if (search) {
    const box = els.find((e) => e.role === 'searchbox') ?? fields.find((e) => /search|query|find/i.test(e.label)) ?? fields[0]
    if (box) return { thought: `Typing the search into ${box.id}.`, actions: [{ type: 'type', id: box.id, text: search[1].replace(/[.!]+$/, ''), submit: true }] }
  }

  const fill = /\b(?:fill|enter|type|put|write)\s+(.+?)\s+(?:in|into|as)\s+(?:the\s+)?(.+?)(?:\s+field)?$/i.exec(part)
  if (fill) {
    const f = best(fields, fill[2])
    if (f) return { thought: `Typing into ${f.el.id}.`, actions: [{ type: 'type', id: f.el.id, text: fill[1] }] }
  }

  const go = /\b(?:go to|open|visit)\s+(https?:\/\/\S+|[a-z0-9-]+\.[a-z.]{2,})/i.exec(part)
  if (go) return { thought: 'Opening the address.', actions: [{ type: 'navigate', url: /^https?:/i.test(go[1]) ? go[1] : `https://${go[1]}` }] }

  const scroll = /\bscroll (up|down)\b/i.exec(part)
  if (scroll) return { thought: 'Scrolling.', actions: [{ type: 'scroll', direction: scroll[1].toLowerCase() === 'up' ? 'up' : 'down', amount: 0.9 }] }

  // Verbs that mean "activate this control". "like"/"follow"/"save" are also the control's own label.
  const act = /\b(click|press|tap|hit|choose|select|pick|tick|check|uncheck|open|continue to|proceed to|go to|like|follow|save|subscribe|accept|reject|add)\s+(?:on\s+)?(.+?)$/i.exec(part)
  if (act) {
    const verb = act[1].toLowerCase()
    let target = act[2]
    let anchor = ''
    const about = /^(?:the\s+)?(?:post|comment|item|product|card|row|one|message|photo|video|entry)?\s*(?:about|for|on|of|with|next to|near|under|from)\s+(.+)$/i.exec(target)
    if (about && /^(like|follow|save|open|select|choose|click|press|tap)$/.test(verb)) { anchor = about[1]; target = '' }
    if (/^(like|follow|save|subscribe|accept|reject|add)$/.test(verb)) target = `${verb} ${target}`.trim()
    if (/^(continue to|proceed to)$/.test(verb)) target = `continue ${target}`.trim()
    if (anchor) {
      const v = verb.slice(0, 4)
      const candidates = els.filter((e) => CLICKABLE.includes(e.role) && words(e.label).some((w) => w.startsWith(v)))
      const el = nearest(req, candidates, anchor)
      if (el) return { thought: `Clicking ${el.id} ("${el.label.slice(0, 40)}") next to the text about ${anchor}.`, actions: [{ type: 'click', id: el.id }] }
    }
    const m = best(els, target, CLICKABLE)
    if (m) {
      if (/^(tick|check|uncheck)$/.test(verb) && m.el.role === 'checkbox') return { thought: `Setting ${m.el.id}.`, actions: [{ type: 'check', id: m.el.id, checked: verb !== 'uncheck' }] }
      return { thought: `Clicking ${m.el.id} ("${m.el.label.slice(0, 40)}").`, actions: [{ type: 'click', id: m.el.id }] }
    }
    if (req.page.scrollY < req.page.scrollMax - 10 && req.step < 4) return { thought: `"${target}" isn't visible yet; scrolling.`, actions: [{ type: 'scroll', direction: 'down', amount: 0.8 }] }
  }
  return null
}

export function rulePlan(req: StepRequest): Plan {
  const task = req.task.trim()
  const els = req.elements
  const fields = els.filter((e) => ['textbox', 'searchbox', 'password', 'textarea'].includes(e.role) && !e.disabled)
  const did = (t: AgentAction['type']) => req.history.some((h) => h.action.type === t && h.ok)

  // Log in: type the task's tokens into the matching fields, then press the login button.
  const login = /\b(log ?in|sign ?in)\b/i.test(task)
  const taskTokens = [...task.matchAll(/\[\[([A-Z_]+)_\d+\]\]/g)].map((m) => ({ token: m[0], type: m[1] }))
  if (login && taskTokens.length) {
    if (did('click')) return { thought: 'Signed in.', actions: [{ type: 'done', summary: 'Filled in the login form and pressed sign in.' }] }
    const acts: AgentAction[] = []
    for (const t of taskTokens) {
      const f = t.type === 'PASSWORD'
        ? fields.find((e) => e.role === 'password')
        : fields.find((e) => e.role !== 'password' && (e.sensitive === t.type || /user|email|login|phone|mobile/i.test(e.label)))
      if (f) acts.push({ type: 'type', id: f.id, text: t.token })
    }
    const btn = best(els, 'sign in', ['button', 'link']) ?? best(els, 'log in', ['button', 'link']) ?? best(els, 'login', ['button'])
    if (btn) acts.push({ type: 'click', id: btn.el.id })
    if (acts.length) return { thought: 'Filling the login form with the hidden credentials and signing in.', actions: acts }
  }

  // Multi-part tasks: one part per completed action, in order.
  const parts = task.split(/\s*,?\s*\b(?:and then|then|and|aur phir|phir)\b\s*/i).map((p) => p.trim()).filter((p) => p.length > 2)
  const doneParts = req.history.filter((h) => h.ok && ['click', 'type', 'select', 'check', 'navigate'].includes(h.action.type)).length
  if (doneParts >= parts.length) return { thought: 'All parts are done.', actions: [{ type: 'done', summary: `Done: ${task}` }] }
  const part = parts[doneParts]
  const plan = planPart(part, req)
  if (plan) return plan
  return {
    thought: 'No model is connected and this step needs one.',
    actions: [{ type: 'ask_user', question: `I couldn't work out "${part}" without a model. Connect Ollama (or a server model), or say it more simply (click / choose / search / fill / log in / scroll).` }]
  }
}
