import type { Stage } from '../stage'
import { ACTIONS, type Action } from '../core/behavior'
import { EMOTIONS } from '../core/expressions'
import { EMOTES } from '../core/fx'

/** Developer panel (run with --manyaki-debug): trigger every clip/expression, watch fps and latency. */
export function mountDebug(stage: Stage, extra: { label: string; run: () => void }[], stats: () => string) {
  const el = document.getElementById('debug')!
  el.classList.remove('hidden')
  const section = (title: string, items: [string, () => void][]) => {
    const h = document.createElement('h4')
    h.textContent = title
    el.append(h)
    for (const [label, fn] of items) {
      const b = document.createElement('button')
      b.textContent = label
      b.onclick = fn
      el.append(b)
    }
  }
  section('clips', stage.motion.names().map((n) => [`${n}${stage.motion.isMocap(n) ? '*' : ''}`, () => {
    stage.motion.play(n)
  }]))
  section('actions', ACTIONS.map((a) => [a, () => void stage.body.act(a as Action)]))
  section('emotions', EMOTIONS.map((e) => [e, () => stage.body.setMood(e)]))
  section('emotions (soft)', EMOTIONS.filter((e) => e !== 'neutral').map((e) => [`${e} 40%`, () => stage.body.setMood(e, 0.4)]))
  section('emotes', EMOTES.map((e) => [e, () => stage.emotes.pop(e)]))
  section('body', [
    ['walk left', () => stage.body.walkTo(100)],
    ['walk right', () => stage.body.walkTo(window.innerWidth - 100)],
    ['sleep', () => stage.body.sleep()],
    ['wake', () => stage.body.wake()],
    ['corner', () => stage.body.goCorner()],
    ['hide', () => stage.setHidden(true)],
    ['show', () => stage.setHidden(false)],
    ['autonomy on/off', () => { stage.body.autonomy = !stage.body.autonomy }]
  ])
  section('app', extra.map((x) => [x.label, x.run]))
  const pre = document.createElement('pre')
  el.append(pre)
  setInterval(() => {
    pre.textContent = `fps ${stage.fps}  mode ${stage.body.mode}  conv ${stage.body.conv}  clip ${stage.motion.current}\n${stats()}`
  }, 500)
}
