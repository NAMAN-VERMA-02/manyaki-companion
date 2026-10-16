import type { Bridge } from '../shared/types'
import { Stage } from './stage'
import { Companion } from './companion'
import { mountDebug } from './ui/debug'

declare global {
  interface Window { manyaki: Bridge }
}

const bridge = window.manyaki
const stage = new Stage(bridge, document.getElementById('stage') as HTMLCanvasElement)

window.addEventListener('error', (e) => bridge.log('error', `${e.message} @ ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => bridge.log('error', `unhandled: ${(e.reason as Error)?.stack ?? e.reason}`))

async function boot() {
  stage.chip.set('waking up… 0%')
  await stage.init((p) => stage.chip.set(`waking up… ${Math.round(p * 100)}%`))
  stage.chip.set('')
  const companion = new Companion(bridge, stage)
  await companion.start()

  const canvas = stage.avatar.renderer.domElement
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    bridge.log('error', 'WebGL context lost; reloading')
    setTimeout(() => location.reload(), 1500)
  })

  if (bridge.debug || new URLSearchParams(location.search).has('debug')) {
    mountDebug(stage, companion.debugActions(), () => companion.debugStats())
  }
  ;(window as unknown as { __manyaki: unknown }).__manyaki = { stage, companion }
}

boot().catch((err) => {
  bridge.log('error', `boot failed: ${(err as Error).stack ?? err}`)
  stage.chip.set('oops, I tripped while waking up 😵 (see log)')
})
