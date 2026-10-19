// Standalone Manyaki Eyes server (for a central deployment or testing without the desktop app).
//
//   npm run eyes:server
//   EYES_PORT=47821 EYES_TOKEN=secret EYES_PROVIDER=ollama EYES_MODEL=qwen2.5vl:3b npm run eyes:server
//   EYES_PROVIDER=openai EYES_BASE_URL=http://gpu-box:8000/v1 EYES_MODEL=Qwen/Qwen2.5-VL-7B-Instruct npm run eyes:server
//
// Bind to 0.0.0.0 (EYES_HOST) only behind TLS and with EYES_TOKEN set.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEyesServer } from './server'
import type { ProviderName } from './providers'

const env = process.env
const here = dirname(fileURLToPath(import.meta.url))
// Built to eyes/server/dist/main.mjs; the fixtures live in eyes/fixtures.
const fixturesDir = env.EYES_FIXTURES ?? [resolve(here, '../../fixtures'), resolve(here, '../fixtures')].find((d) => existsSync(d))
const server = createEyesServer({
  fixturesDir,
  port: Number(env.EYES_PORT ?? 47821),
  host: env.EYES_HOST ?? '127.0.0.1',
  token: env.EYES_TOKEN ?? '',
  provider: {
    provider: (env.EYES_PROVIDER as ProviderName) ?? 'auto',
    model: env.EYES_MODEL,
    baseUrl: env.EYES_BASE_URL,
    apiKey: env.EYES_API_KEY,
    geminiKey: env.GEMINI_API_KEY
  },
  onEvent: (e) => console.log(`[eyes] ${e.kind} ${e.task ?? ''} ${e.detail ?? ''}`.trim())
})

server.start().catch((e) => {
  console.error(`[eyes] could not start: ${(e as Error).message}`)
  process.exit(1)
})
process.on('SIGINT', () => void server.stop().then(() => process.exit(0)))
