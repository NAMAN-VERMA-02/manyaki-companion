import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyField, findPII, verhoeff } from '../eyes/shared/pii'
import { Vault } from '../eyes/shared/vault'
import { scrubPayload } from '../eyes/shared/leakguard'
import { iou, matchBoxes, pixelScores, prf } from '../eyes/shared/metrics'
import { extractJson, needsConfirmation, validateActions } from '../eyes/shared/actions'
import { buildObservation, parsePlan, rulePlan } from '../eyes/server/planner'
import { createEyesServer, type EyesEvent, type EyesServer } from '../eyes/server/server'
import { SCHEME, type ScreenElement, type StepRequest } from '../eyes/shared/protocol'

const types = (t: string) => findPII(t).map((s) => s.type)
const values = (t: string) => findPII(t).map((s) => t.slice(s.start, s.end))

describe('PII detection', () => {
  it('finds common identifiers with exact spans', () => {
    const t = 'Mail asha.verma@example.com or call +91 98765 43210 today'
    expect(values(t)).toEqual(['asha.verma@example.com', '+91 98765 43210'])
    expect(types('Card 4111 1111 1111 1111 exp 09/29')).toContain('CARD')
    expect(types('PAN ABCPV1234K')).toEqual(['PAN'])
    expect(types('IFSC NOVA0123456')).toEqual(['IFSC'])
    expect(types('pay to asha@okaxis')).toEqual(['UPI'])
    expect(types('key sk-ant-REDACTEDexample1234567890ab')).toEqual(['SECRET'])
    expect(types('SSN 123-45-6789')).toEqual(['SSN'])
  })
  it('validates checksums so look-alikes are not flagged', () => {
    expect(verhoeff('498732105640')).toBe(true)
    expect(types('Aadhaar 4987 3210 5640')).toEqual(['AADHAAR'])
    expect(types('Order code 1234-5678-9012')).toEqual([]) // fails Verhoeff and Luhn
    expect(types('Card 4111 1111 1111 1112')).toEqual([])   // fails Luhn
    expect(types('SKU 400012345678 · 87 keys')).toEqual([])
  })
  it('does not flag versions, prices or ratings', () => {
    expect(types('firmware v10.2.0.1, batch 2026.10.19.7, version 2.1.0.4')).toEqual([])
    expect(types('₹2,499 · rated 4.4 by 12,345 buyers')).toEqual([])
    expect(types('server at 192.168.1.20')).toEqual(['IP'])
  })
  it('uses context for things with no fixed shape', () => {
    expect(values('Name: Asha Verma')).toEqual(['Asha Verma'])
    expect(values('Your OTP is 482913. Never share it')).toEqual(['482913'])
    expect(values('DOB: 12/03/2001')).toEqual(['12/03/2001'])
    expect(values('my password is hunter2!')).toEqual(['hunter2!'])
    expect(types('Posted by Dr. Meera Krishnan')).toEqual(['NAME'])
    expect(values('Posted by Meera Krishnan')).toEqual(['Meera Krishnan'])
    expect(types('Posted by Campus Admin')).toEqual([])
    expect(values('Sign in with a@b.co and password Tr0ub4dor&3')).toEqual(['a@b.co', 'Tr0ub4dor&3'])
    expect(types('Enter your password below')).toEqual([])
    expect(types('Rated 4.4 by 12,345 buyers since 01/02/2025')).toEqual([])
  })
  it('classifies form fields from attributes alone', () => {
    expect(classifyField({ tag: 'input', type: 'password' })).toBe('PASSWORD')
    expect(classifyField({ tag: 'input', autocomplete: 'cc-number' })).toBe('CARD')
    expect(classifyField({ tag: 'input', name: 'aadhaar_no' })).toBe('AADHAAR')
    expect(classifyField({ tag: 'input', label: 'Full name' })).toBe('NAME')
    expect(classifyField({ tag: 'input', placeholder: 'Mobile number' })).toBe('PHONE')
    expect(classifyField({ tag: 'input', name: 'otpCode' })).toBe('OTP')
    expect(classifyField({ tag: 'input', label: 'Search products' })).toBeNull()
    expect(classifyField({ tag: 'input', label: 'Project name' })).toBeNull()
  })
})

describe('vault', () => {
  it('gives stable tokens and restores values only locally', () => {
    const v = new Vault()
    const a = v.tokenize('Sign in with asha.verma@example.com, OTP is 482913')
    expect(a.text).toBe('Sign in with [[EMAIL_1]], OTP is [[OTP_1]]')
    expect(v.tokenize('again asha.verma@example.com').text).toBe('again [[EMAIL_1]]')
    expect(v.token('PASSWORD', 'Tr0ub4dor&3')).toBe('[[PASSWORD_1]]')
    expect(v.rehydrate('type [[EMAIL_1]] then [[PASSWORD_1]] and [[CARD_9]]')).toBe('type asha.verma@example.com then Tr0ub4dor&3 and [[CARD_9]]')
  })
})

describe('leak guard', () => {
  it('masks anything private left in a payload, but not tokens', () => {
    const { clean, findings } = scrubPayload({ task: 'log in as [[EMAIL_1]]', text: ['call 9876543210 now', 'ok'], nested: { label: 'x@y.com' }, image: 'AAAA' })
    expect(findings.map((f) => f.path)).toEqual(['text[0]', 'nested.label'])
    expect(clean.text[0]).toBe('call [[PHONE_LEAK]] now')
    expect(clean.task).toBe('log in as [[EMAIL_1]]')
    expect(clean.image).toBe('AAAA')
  })
})

describe('metrics', () => {
  it('computes PRF, IoU, matching and pixel scores', () => {
    expect(prf(8, 2, 0)).toMatchObject({ precision: 0.8, recall: 1 })
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(1 / 3)
    const m = matchBoxes([{ x: 0, y: 0, w: 12, h: 12 }, { x: 100, y: 100, w: 5, h: 5 }], [{ x: 1, y: 1, w: 10, h: 10 }, { x: 50, y: 50, w: 5, h: 5 }])
    expect(m).toMatchObject({ tp: 1, fp: 1, fn: 1 })
    const px = pixelScores([{ x: 0, y: 0, w: 20, h: 10 }], [{ x: 0, y: 0, w: 10, h: 10 }], 1)
    expect(px.precision).toBeCloseTo(0.5)
    expect(px.recall).toBeCloseTo(1)
  })
})

const el = (id: string, role: ScreenElement['role'], label: string, extra: Partial<ScreenElement> = {}): ScreenElement =>
  ({ id, role, tag: role === 'button' ? 'button' : 'input', label, box: { x: 10, y: 10, w: 100, h: 30 }, ...extra })

function request(task: string, elements: ScreenElement[], extra: Partial<StepRequest> = {}): StepRequest {
  return { scheme: SCHEME, task, page: { host: 'bank.test', title: 'Sign in', viewport: { w: 1280, h: 720 }, scrollY: 0, scrollMax: 900 }, elements, text: [], redactions: [], history: [], step: 0, ...extra }
}

describe('actions', () => {
  it('extracts JSON from fenced or chatty replies', () => {
    expect(extractJson('Sure!\n```json\n{"actions":[{"type":"click","id":"e1"}]}\n```')).toEqual({ actions: [{ type: 'click', id: 'e1' }] })
    expect(extractJson('{"thought":"a } in a string","actions":[]} trailing')).toEqual({ thought: 'a } in a string', actions: [] })
  })
  it('drops unknown ids and clamps values', () => {
    const a = validateActions({ actions: [{ type: 'click', id: 'e99' }, { type: 'click', id: 'e1' }, { type: 'scroll', direction: 'down', amount: 50 }, { type: 'navigate', url: 'javascript:alert(1)' }] }, new Set(['e1']))
    expect(a).toEqual([{ type: 'click', id: 'e1' }, { type: 'scroll', direction: 'down', amount: 3 }])
  })
  it('asks the user before risky actions', () => {
    expect(needsConfirmation({ type: 'click', id: 'e1' }, el('e1', 'button', 'Pay ₹870'), 'shop.test')).toMatch(/Pay/)
    expect(needsConfirmation({ type: 'click', id: 'e1' }, el('e1', 'button', 'Next'), 'shop.test')).toBeNull()
    expect(needsConfirmation({ type: 'navigate', url: 'https://evil.test/x' }, undefined, 'shop.test')).toMatch(/evil/)
  })
})

describe('planner', () => {
  const login = [el('e1', 'textbox', 'Email', { sensitive: 'EMAIL' }), el('e2', 'password', 'Password', { sensitive: 'PASSWORD' }), el('e3', 'button', 'Sign in')]
  it('builds a compact observation without raw values', () => {
    const o = buildObservation(request('Sign in with [[EMAIL_1]] and password [[PASSWORD_1]]', login))
    expect(o).toContain('e2 password "Password" [private password field]')
    expect(o).not.toMatch(/@|Tr0ub/)
  })
  it('parses a model plan and keeps only valid actions', () => {
    const p = parsePlan('{"thought":"fill it","actions":[{"type":"type","id":"e1","text":"[[EMAIL_1]]"},{"type":"click","id":"e7"}]}', request('x', login))
    expect(p.actions).toEqual([{ type: 'type', id: 'e1', text: '[[EMAIL_1]]', submit: false }])
  })
  it('rule planner logs in with tokens, searches and clicks', () => {
    expect(rulePlan(request('Sign in with [[EMAIL_1]] and password [[PASSWORD_1]]', login)).actions).toEqual([
      { type: 'type', id: 'e1', text: '[[EMAIL_1]]' }, { type: 'type', id: 'e2', text: '[[PASSWORD_1]]' }, { type: 'click', id: 'e3' }
    ])
    const shop = [el('e1', 'searchbox', 'Search products'), el('e2', 'button', 'Search')]
    expect(rulePlan(request('Search for wireless earbuds', shop)).actions).toEqual([{ type: 'type', id: 'e1', text: 'wireless earbuds', submit: true }])
    expect(rulePlan(request('click continue to payment', [el('e5', 'button', 'Continue to payment')])).actions).toEqual([{ type: 'click', id: 'e5' }])
    expect(rulePlan(request('open github.com', [])).actions[0]).toEqual({ type: 'navigate', url: 'https://github.com' })
  })
  it('rule planner runs multi-part tasks in order and fuzzy-matches labels', () => {
    const els = [el('e1', 'radio', 'Standard (2–3 days) · free'), el('e2', 'radio', 'Express (today) · ₹49'), el('e3', 'button', 'Continue to payment')]
    const task = 'Choose express delivery and continue to payment'
    expect(rulePlan(request(task, els)).actions).toEqual([{ type: 'click', id: 'e2' }])
    const after1 = request(task, els, { history: [{ action: { type: 'click', id: 'e2' }, ok: true }] })
    expect(rulePlan(after1).actions).toEqual([{ type: 'click', id: 'e3' }])
    const after2 = request(task, els, { history: [...after1.history, { action: { type: 'click', id: 'e3' }, ok: true }] })
    expect(rulePlan(after2).actions[0].type).toBe('done')
  })
  it('rule planner grounds "the post about X" to the nearest control', () => {
    const els = [
      el('e1', 'button', '♡ Like', { box: { x: 20, y: 160, w: 60, h: 28 } }),
      el('e2', 'button', '♡ Like', { box: { x: 20, y: 420, w: 60, h: 28 } })
    ]
    const r = request('Like the post about the hackathon', els, {
      text: ['Selling my old DSA books', 'Our team made it to the finals of the CodeX hackathon!'],
      textBoxes: [{ x: 20, y: 330, w: 600, h: 40 }, { x: 20, y: 90, w: 600, h: 48 }]
    })
    expect(rulePlan(r).actions).toEqual([{ type: 'click', id: 'e1' }])
  })
})

describe('server (rules planner, real HTTP)', () => {
  let srv: EyesServer
  let base = ''
  const events: EyesEvent[] = []
  beforeAll(async () => {
    srv = createEyesServer({ port: 0, token: 'pair-123', provider: { provider: 'rules' }, onEvent: (e) => events.push(e), log: () => undefined })
    base = `http://127.0.0.1:${await srv.start()}`
  })
  afterAll(() => srv.stop())

  const auth = { authorization: 'Bearer pair-123', 'content-type': 'application/json' }

  it('needs the pairing code and rejects web-page origins', async () => {
    expect((await fetch(`${base}/v1/step`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(`${base}/health`, { headers: { origin: 'https://evil.test' } })).status).toBe(403)
    const ok = await fetch(`${base}/health`, { headers: { origin: 'chrome-extension://abc' } })
    expect(ok.headers.get('access-control-allow-origin')).toBe('chrome-extension://abc')
  })
  it('plans a step and masks a leaked value before planning', async () => {
    const body = request('Sign in with [[EMAIL_1]] and password [[PASSWORD_1]]', [
      el('e1', 'textbox', 'Email', { sensitive: 'EMAIL' }), el('e2', 'password', 'Password'), el('e3', 'button', 'Sign in')
    ], { text: ['support: help@bank.test'] })
    const r = await (await fetch(`${base}/v1/step`, { method: 'POST', headers: auth, body: JSON.stringify(body) })).json()
    expect(r.model).toBe('rules')
    expect(r.leaks).toBe(1)
    expect(r.actions.map((a: { type: string }) => a.type)).toEqual(['type', 'type', 'click'])
  })
  it('hands a queued task to a long-polling extension, and relays events', async () => {
    const poll = fetch(`${base}/v1/tasks/next`, { headers: auth }).then((r) => r.json())
    await new Promise((r) => setTimeout(r, 50))
    srv.addTask('search for lofi beats')
    expect((await poll).task).toBe('search for lofi beats')
    await fetch(`${base}/v1/events`, { method: 'POST', headers: auth, body: JSON.stringify({ kind: 'done', task: 't', redactions: 3 }) })
    expect(events.at(-1)).toMatchObject({ kind: 'done', redactions: 3 })
  })
})
