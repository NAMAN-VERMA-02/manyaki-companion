import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { SCHEME, type StepRequest, type StepResponse } from '../shared/protocol'
import { scrubPayload } from '../shared/leakguard'
import { buildObservation, parsePlan, rulePlan, SYSTEM_PROMPT } from './planner'
import { resolvePlanner, type Planner, type ProviderConfig } from './providers'

// The Manyaki Eyes server: receives a sanitised screen, asks a model what to do, returns actions.
// No dependencies (node:http), so it runs standalone (`npm run eyes:server`) or inside Manyaki's main
// process. It only ever sees what the client already redacted, and re-checks that with its own leak
// guard before anything reaches a model.

export interface EyesEvent {
  kind: 'connected' | 'task' | 'step' | 'done' | 'error' | 'ask'
  task?: string
  detail?: string
  step?: number
  redactions?: number
  ms?: number
}

export interface EyesServerOptions {
  port: number
  host?: string
  /** Pairing token the extension must send (Authorization: Bearer …). Empty: no auth (local dev only). */
  token?: string
  provider: ProviderConfig
  onEvent?: (e: EyesEvent) => void
  log?: (msg: string) => void
  /** Folder of labelled benchmark pages, served at /fixtures/ (synthetic data only). */
  fixturesDir?: string
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.css': 'text/css', '.js': 'text/javascript' }

export interface EyesServer {
  readonly server: Server
  start(): Promise<number>
  stop(): Promise<void>
  /** Queue a task for the extension to pick up (from Manyaki's voice or chat). */
  addTask(task: string): void
  setProvider(cfg: ProviderConfig): void
  stats(): Record<string, unknown>
}

const MAX_BODY = 12 * 1024 * 1024

export function createEyesServer(opts: EyesServerOptions): EyesServer {
  const log = opts.log ?? ((m: string) => console.log(`[eyes] ${m}`))
  let cfg = opts.provider
  let planner: Planner | null = null
  let plannerAt = 0
  let plannerError = ''
  const queue: { id: string; task: string }[] = []
  const waiters = new Set<(t: { id: string; task: string } | null) => void>()
  const stat = { steps: 0, modelMs: 0, leaksCaught: 0, failures: 0, lastSeen: 0, tasks: 0 }

  async function getPlanner(force = false): Promise<Planner | null> {
    if (!force && Date.now() - plannerAt < 60000) return planner
    plannerAt = Date.now()
    try {
      planner = await resolvePlanner(cfg)
      plannerError = ''
    } catch (e) {
      planner = null
      plannerError = (e as Error).message
      log(`planner: ${plannerError}`)
    }
    return planner
  }

  function cors(req: IncomingMessage, res: ServerResponse) {
    const origin = String(req.headers.origin ?? '')
    // Only browser extensions (and tools without an Origin, like curl) may call it; web pages may not.
    if (/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-headers', 'authorization, content-type')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      res.setHeader('access-control-max-age', '600')
    }
    return !origin || /^(chrome|moz|safari-web)-extension:\/\//.test(origin)
  }

  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  function readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(e) } })
      req.on('error', reject)
    })
  }

  async function step(raw: StepRequest): Promise<StepResponse> {
    const t0 = Date.now()
    if (raw?.scheme !== SCHEME) throw new Error(`expected scheme ${SCHEME}`)
    // Server-side leak guard: mask anything private-looking that slipped through, and count it.
    const { image, ...rest } = raw
    const { clean, findings } = scrubPayload(rest)
    if (findings.length) {
      stat.leaksCaught += findings.length
      log(`leak guard masked ${findings.length} value(s) in ${[...new Set(findings.map((f) => f.path.split('[')[0]))].join(', ')}`)
    }
    const req = { ...clean, image } as StepRequest
    const p = await getPlanner()
    let plan: { thought: string; actions: StepResponse['actions'] }
    let model = 'rules'
    let error: string | undefined
    if (p) {
      try {
        const reply = await p.plan(SYSTEM_PROMPT, buildObservation(req), p.vision ? req.image : undefined)
        plan = parsePlan(reply, req)
        model = p.name
        if (!plan.actions.length) {
          // A reply with no usable action: one clarifying retry, then the rule planner.
          const again = await p.plan(SYSTEM_PROMPT, `${buildObservation(req)}\n\nYour last reply had no valid action. Use only listed ids. JSON only.`, undefined)
          plan = parsePlan(again, req)
        }
      } catch (e) {
        error = (e as Error).message
        stat.failures++
        log(`model failed: ${error}`)
        void getPlanner(true)
        plan = { thought: '', actions: [] }
      }
      if (!plan.actions.length) { plan = rulePlan(req); model = `${model}→rules` }
    } else plan = rulePlan(req)
    const ms = Date.now() - t0
    stat.steps++
    stat.modelMs += ms
    return { ...plan, model, ms, leaks: findings.length, ...(error ? { error } : {}) }
  }

  const server = createServer(async (req, res) => {
    const allowed = cors(req, res)
    if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); res.end(); return }
    if (!allowed) return send(res, 403, { error: 'origin not allowed' })
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/health') {
      const p = await getPlanner()
      return send(res, 200, { ok: true, scheme: SCHEME, planner: p?.name ?? 'rules', vision: !!p?.vision, plannerError, auth: !!opts.token })
    }
    if (req.method === 'GET' && url.pathname.startsWith('/fixtures/') && opts.fixturesDir) {
      const base = resolve(opts.fixturesDir)
      const file = resolve(join(base, decodeURIComponent(url.pathname.slice('/fixtures/'.length)) || 'index.json'))
      if (!file.startsWith(base + sep)) return send(res, 403, { error: 'forbidden' })
      try {
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(body)
      } catch { send(res, 404, { error: 'not found' }) }
      return
    }
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return send(res, 401, { error: 'pairing code missing or wrong' })
    stat.lastSeen = Date.now()
    try {
      if (req.method === 'POST' && url.pathname === '/v1/step') {
        const body = (await readJson(req)) as StepRequest
        return send(res, 200, await step(body))
      }
      if (req.method === 'GET' && url.pathname === '/v1/tasks/next') {
        const next = queue.shift()
        if (next) return send(res, 200, next)
        // Long poll: answer when a task arrives, or with null after ~25 s so the client re-polls.
        let done = false
        const finish = (t: { id: string; task: string } | null) => {
          if (done) return
          done = true
          waiters.delete(finish)
          clearTimeout(timer)
          send(res, 200, t ?? { id: null, task: null })
        }
        const timer = setTimeout(() => finish(null), 25000)
        waiters.add(finish)
        req.on('close', () => { if (!done) { done = true; waiters.delete(finish); clearTimeout(timer) } })
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/events') {
        const e = (await readJson(req)) as EyesEvent
        const kind = ['connected', 'task', 'step', 'done', 'error', 'ask'].includes(String(e.kind)) ? e.kind : 'step'
        opts.onEvent?.({
          kind,
          task: typeof e.task === 'string' ? e.task.slice(0, 200) : undefined,
          detail: typeof e.detail === 'string' ? e.detail.slice(0, 300) : undefined,
          step: Number(e.step) || 0,
          redactions: Number(e.redactions) || 0,
          ms: Number(e.ms) || 0
        })
        return send(res, 200, { ok: true })
      }
      if (req.method === 'GET' && url.pathname === '/metrics') return send(res, 200, api.stats())
      send(res, 404, { error: 'not found' })
    } catch (e) {
      send(res, 400, { error: (e as Error).message })
    }
  })

  const api: EyesServer = {
    server,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
        const a = server.address()
        const port = typeof a === 'object' && a ? a.port : opts.port
        log(`listening on http://${opts.host ?? '127.0.0.1'}:${port}`)
        void getPlanner(true).then((p) => log(`planner: ${p?.name ?? 'rules (no model reachable)'}`))
        resolve(port)
      })
    }),
    stop: () => new Promise((resolve) => {
      for (const w of [...waiters]) w(null)
      server.close(() => resolve())
      server.closeAllConnections?.()
    }),
    addTask(task) {
      const item = { id: Math.random().toString(36).slice(2, 10), task: task.slice(0, 500) }
      stat.tasks++
      const w = [...waiters][0]
      if (w) w(item)
      else { queue.push(item); if (queue.length > 5) queue.shift() }
    },
    setProvider(next) { cfg = next; plannerAt = 0 },
    stats: () => ({
      ...stat,
      avgStepMs: stat.steps ? Math.round(stat.modelMs / stat.steps) : 0,
      planner: planner?.name ?? 'rules',
      extensionConnected: Date.now() - stat.lastSeen < 40000
    })
  }
  return api
}
