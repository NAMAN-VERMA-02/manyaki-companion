import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'electron/main.ts'), localbrain: resolve(__dirname, 'electron/localbrain.ts') } }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    base: './',
    publicDir: false,
    worker: { format: 'es' },
    build: {
      target: 'esnext',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html'),
          settings: resolve(__dirname, 'src/settings.html')
        }
      }
    }
  }
})
