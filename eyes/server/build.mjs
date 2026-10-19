// Bundles the standalone Eyes server into eyes/server/dist/main.mjs (plain Node, no dependencies).
import { build } from 'vite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: join(here, 'main.ts'),
    outDir: join(here, 'dist'),
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: { output: { format: 'es', entryFileNames: 'main.mjs' } }
  }
})
