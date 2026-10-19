import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createEyesServer, type EyesEvent, type EyesServer } from '../eyes/server/server'
import type { ProviderConfig } from '../eyes/server/providers'
import type { EyesInfo, Settings } from '../shared/types'

// Manyaki hosts the Manyaki Eyes server (the browser agent's planner) on 127.0.0.1:47821, so the
// extension works with nothing else installed. It only ever receives what the extension already
// redacted. The extension must present the pairing code shown in Manyaki Home.

export const EYES_PORT = 47821

let server: EyesServer | null = null
let state: EyesInfo = { running: false, port: EYES_PORT, pairing: '', planner: 'rules', connected: false, error: '' }

export function providerFor(s: Settings, geminiKey: string): ProviderConfig {
  switch (s.eyesPlanner) {
    case 'ollama': return { provider: 'ollama' }
    case 'gemini': return { provider: 'gemini', geminiKey }
    case 'rules': return { provider: 'rules' }
    // auto: an open-weights model on this PC if Ollama has one, else her Gemini key, else rules.
    default: return { provider: 'auto', geminiKey: geminiKey || undefined }
  }
}

export async function startEyes(opts: {
  settings: Settings
  geminiKey: string
  pairing: string
  appPath: string
  onEvent: (e: EyesEvent) => void
  log: (level: string, msg: string) => void
}): Promise<EyesInfo> {
  await stopEyes()
  const fixtures = [join(opts.appPath, 'eyes', 'fixtures'), join(process.resourcesPath ?? '', 'eyes', 'fixtures')].find((d) => existsSync(d))
  server = createEyesServer({
    port: EYES_PORT,
    token: opts.pairing,
    provider: providerFor(opts.settings, opts.geminiKey),
    fixturesDir: fixtures,
    onEvent: opts.onEvent,
    log: (m) => opts.log('info', `eyes: ${m}`)
  })
  try {
    await server.start()
    state = { ...state, running: true, pairing: opts.pairing, error: '' }
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `port ${EYES_PORT} is busy (is a standalone Eyes server running?)` : (e as Error).message
    opts.log('warn', `eyes: ${msg}`)
    server = null
    state = { ...state, running: false, error: msg }
  }
  return eyesInfo()
}

export async function stopEyes() {
  const s = server
  server = null
  state = { ...state, running: false }
  if (s) await s.stop().catch(() => undefined)
}

export function eyesInfo(): EyesInfo {
  const st = server?.stats() as { planner?: string; extensionConnected?: boolean } | undefined
  return { ...state, planner: st?.planner ?? state.planner, connected: !!st?.extensionConnected }
}

export function setEyesProvider(s: Settings, geminiKey: string) {
  server?.setProvider(providerFor(s, geminiKey))
}

/** Queue a task for the extension. False when the server isn't running. */
export function eyesTask(task: string): boolean {
  if (!server) return false
  server.addTask(task)
  return true
}

export const newPairingCode = () => randomBytes(9).toString('base64url')
