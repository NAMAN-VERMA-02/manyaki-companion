import type { AgentAction, ScreenElement } from './protocol'

// Server output is untrusted: it is parsed defensively, unknown element ids are dropped, values are
// clamped, and anything with real-world consequences (paying, deleting, sending, leaving the site) needs
// the user's explicit OK in the panel before the client does it.

const MAX_TEXT = 500

/** Pulls the first JSON object out of a model's reply (models wrap JSON in prose or code fences). */
export function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(body.slice(start, i + 1)) } catch { return null }
    }
  }
  return null
}

/** Validated actions from a model's JSON (`{actions:[...]}` or a single action). Bad ones are dropped. */
export function validateActions(input: unknown, known: Set<string>, max = 5): AgentAction[] {
  const o = input as { actions?: unknown; action?: unknown } | null
  const list = Array.isArray(o?.actions) ? o!.actions : o?.action ? [o.action] : Array.isArray(input) ? input : []
  const out: AgentAction[] = []
  for (const raw of list as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue
    const type = String(raw.type ?? raw.action ?? '').toLowerCase()
    const id = typeof raw.id === 'string' ? raw.id : typeof raw.element === 'string' ? raw.element : typeof raw.target === 'string' ? raw.target : ''
    const needsId = ['click', 'type', 'select', 'check'].includes(type)
    if (needsId && !known.has(id)) continue
    switch (type) {
      case 'click': out.push({ type, id }); break
      case 'type': out.push({ type, id, text: String(raw.text ?? raw.value ?? '').slice(0, MAX_TEXT), submit: raw.submit === true }); break
      case 'select': out.push({ type, id, option: String(raw.option ?? raw.value ?? '').slice(0, 200) }); break
      case 'check': out.push({ type, id, checked: raw.checked !== false }); break
      case 'scroll': out.push({ type, direction: raw.direction === 'up' ? 'up' : 'down', amount: Math.max(0.2, Math.min(3, Number(raw.amount) || 0.8)) }); break
      case 'navigate': {
        const url = String(raw.url ?? '')
        if (/^https?:\/\//i.test(url)) out.push({ type, url: url.slice(0, 500) })
        break
      }
      case 'wait': out.push({ type, ms: Math.max(100, Math.min(5000, Number(raw.ms) || 800)) }); break
      case 'ask_user': out.push({ type, question: String(raw.question ?? raw.text ?? '').slice(0, 300) }); break
      case 'done': out.push({ type, summary: String(raw.summary ?? raw.text ?? '').slice(0, 400) }); break
    }
    if (out.length >= max || type === 'done' || type === 'ask_user') break
  }
  return out
}

const RISKY = /\b(pay|payment|buy|purchase|place order|checkout|confirm order|book now|transfer|send money|donate|subscribe|delete|remove account|deactivate|unsubscribe|sign out|log ?out|submit application|send|post|publish|withdraw)\b/i

/** Why an action needs the user's OK first, or null if it can run on its own. */
export function needsConfirmation(a: AgentAction, el: ScreenElement | undefined, currentHost: string): string | null {
  if (a.type === 'navigate') {
    try {
      const host = new URL(a.url).host
      return host === currentHost ? null : `open another site (${host})`
    } catch { return 'open an unknown address' }
  }
  if (a.type === 'click' && el && RISKY.test(`${el.label} ${el.value ?? ''}`)) return `press "${el.label.slice(0, 60)}"`
  if (a.type === 'type' && a.submit && el && RISKY.test(el.label)) return `submit "${el.label.slice(0, 60)}"`
  return null
}
