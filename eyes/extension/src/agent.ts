import type { AgentAction, HistoryItem, ScreenElement, StepResponse } from '../../shared/protocol'
import { needsConfirmation } from '../../shared/actions'
import { Vault } from '../../shared/vault'
import { observe, send, type Observation, type ObserveOptions } from './pipeline'

// The agent loop: observe (on device) -> plan (server, sanitised) -> act (on device, values restored
// locally) -> repeat. Risky steps wait for the user's OK. Used by the panel and the benchmark.

export interface AgentSettings extends ObserveOptions {
  serverUrl: string
  pairing: string
  maxSteps: number
}

export interface AgentUI {
  onObservation(o: Observation): void
  onPlan(r: StepResponse, o: Observation): void
  onAction(a: AgentAction, ok: boolean, note?: string): void
  confirm(question: string): Promise<boolean>
  ask(question: string): Promise<string | null>
  status(text: string): void
}

export interface RunResult { ok: boolean; summary: string; steps: number; ms: number; stepMs: number[]; serverMs: number[] }

const SECRET_TOKEN = /\[\[(PASSWORD|CARD|CVV|OTP|SECRET|AADHAAR|PAN|BANK_ACCOUNT|SSN)_\d+\]\]/
const TOKEN_TYPE = /\[\[([A-Z_]+)_\d+\]\]/

export async function post<T>(s: AgentSettings, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${s.serverUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.pairing ? { authorization: `Bearer ${s.pairing}` } : {}) },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 160)}`)
  return res.json() as Promise<T>
}

/** Tell the server (and so Manyaki) what's happening. Never includes values, only counts and tokens. */
export function event(s: AgentSettings, e: { kind: string; task?: string; detail?: string; step?: number; redactions?: number; ms?: number }) {
  void post(s, '/v1/events', e).catch(() => undefined)
}

async function settle(tabId: number, maxMs = 8000) {
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, 250))
  while (Date.now() - t0 < maxMs) {
    const t = await chrome.tabs.get(tabId)
    if (t.status === 'complete') break
    await new Promise((r) => setTimeout(r, 150))
  }
  await new Promise((r) => setTimeout(r, 200))
}

/**
 * Secrets may only be typed into a field of the same kind ([[PASSWORD_1]] into a password box). Anything
 * else could be a planner (or a page tricking it) trying to make a secret visible, so the user decides.
 */
function secretMisuse(a: AgentAction, el: ScreenElement | undefined): string | null {
  if (a.type !== 'type' || !SECRET_TOKEN.test(a.text)) return null
  const want = TOKEN_TYPE.exec(a.text)?.[1]
  const fits = el && (el.sensitive === want || (want === 'PASSWORD' && el.role === 'password'))
  return fits ? null : `type a hidden ${want?.toLowerCase()} into "${el?.label.slice(0, 40) ?? 'a field'}"`
}

export class Agent {
  running = false
  vault = new Vault()
  last: Observation | null = null

  constructor(private readonly ui: AgentUI) {}

  stop() { this.running = false }

  async run(rawTask: string, settings: AgentSettings, tabId?: number): Promise<RunResult> {
    const t0 = performance.now()
    this.running = true
    this.vault = new Vault()
    const history: HistoryItem[] = []
    const stepMs: number[] = []
    const serverMs: number[] = []
    // The task itself may contain their details ("log in with me@x.com"): those become tokens too.
    let task = this.vault.tokenize(rawTask).text
    const tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    if (!tab?.id || !/^https?:|^file:/.test(tab.url ?? '')) {
      this.running = false
      return { ok: false, summary: 'Open a normal web page first (browser pages like chrome:// are off limits).', steps: 0, ms: 0, stepMs, serverMs }
    }
    event(settings, { kind: 'task', task })
    let summary = ''
    let ok = false
    let step = 0
    try {
      for (; step < settings.maxSteps && this.running; step++) {
        const s0 = performance.now()
        this.ui.status(`step ${step + 1}: looking (on device)…`)
        const obs = await observe(await chrome.tabs.get(tab.id), task, this.vault, history, step, settings)
        this.last = obs
        this.ui.onObservation(obs)
        this.ui.status(`step ${step + 1}: asking the server (sanitised)…`)
        const q0 = performance.now()
        const plan = await post<StepResponse>(settings, '/v1/step', obs.request)
        serverMs.push(performance.now() - q0)
        this.ui.onPlan(plan, obs)
        event(settings, { kind: 'step', task, step, detail: plan.thought, redactions: obs.request.redactions.length, ms: performance.now() - s0 })
        if (!plan.actions.length) { summary = plan.error ? `Server problem: ${plan.error}` : 'The planner had nothing to do.'; break }

        let changed = false
        for (const a of plan.actions) {
          if (!this.running) break
          if (a.type === 'done') { ok = true; summary = this.vault.rehydrate(a.summary); this.running = false; break }
          if (a.type === 'ask_user') {
            const ans = await this.ui.ask(a.question)
            if (ans === null) { summary = 'Stopped: you didn\'t answer.'; this.running = false; break }
            const clean = this.vault.tokenize(ans).text
            task += ` (they answered: ${clean})`
            history.push({ action: a, ok: true, note: clean })
            changed = true
            break
          }
          const el = 'id' in a ? obs.request.elements.find((e) => e.id === a.id) : undefined
          const why = needsConfirmation(a, el, obs.request.page.host) ?? secretMisuse(a, el)
          if (why && !(await this.ui.confirm(`Manyaki wants to ${why}. Allow?`))) {
            history.push({ action: a, ok: false, note: 'the user said no' })
            this.ui.onAction(a, false, 'you said no')
            changed = true
            break
          }
          let res: { ok: boolean; note?: string }
          if (a.type === 'navigate') {
            await chrome.tabs.update(tab.id, { url: a.url })
            res = { ok: true }
          } else {
            // Real values are restored here, on the device, right before typing.
            const value = a.type === 'type' ? this.vault.rehydrate(a.text) : a.type === 'select' ? this.vault.rehydrate(a.option) : undefined
            res = await send<{ ok: boolean; note?: string }>(tab.id, { type: 'act', action: a, value }).catch((e: Error) => ({ ok: false, note: e.message }))
          }
          history.push({ action: a, ok: res.ok, note: res.note })
          this.ui.onAction(a, res.ok, res.note)
          // Anything that may load a new page ends this round: the next view must be fresh.
          if (a.type === 'navigate' || (a.type === 'click' && (el?.role === 'link' || el?.role === 'button')) || (a.type === 'type' && a.submit)) { changed = true; break }
        }
        stepMs.push(performance.now() - s0)
        if (!this.running) break
        if (changed) await settle(tab.id)
        else await new Promise((r) => setTimeout(r, 150))
      }
      if (!summary) summary = this.running ? `Stopped after ${settings.maxSteps} steps.` : 'Stopped.'
    } catch (e) {
      summary = `Error: ${(e as Error).message}`
    } finally {
      this.running = false
      await send(tab.id, { type: 'privacy-view', boxes: null }).catch(() => undefined)
    }
    const ms = performance.now() - t0
    event(settings, { kind: ok ? 'done' : 'error', task, detail: this.vault.tokenize(summary).text, step, ms })
    return { ok, summary, steps: step + (ok ? 1 : 0), ms, stepMs, serverMs }
  }
}
