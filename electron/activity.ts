import { powerMonitor, screen } from 'electron'
import type { ActivitySnapshot } from '../shared/types'
import { classify } from './classify'
import { getSettings } from './store'

type Listener = (a: ActivitySnapshot) => void

// Polls the foreground window once a second. Only changes (plus a periodic heartbeat for idle time)
// are pushed to the renderer, so the overlay is not woken up needlessly.
export function startActivityWatcher(ownPid: number, onChange: Listener): () => void {
  let last = ''
  let lastSent = 0
  let busy = false
  let getWin: typeof import('get-windows').activeWindow | null = null

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      if (!getWin) getWin = (await import('get-windows')).activeWindow
      const w = await getWin().catch(() => undefined)
      const idleSeconds = powerMonitor.getSystemIdleTime()
      const settings = getSettings()

      let snap: ActivitySnapshot
      if (!w || w.owner.processId === ownPid) {
        snap = { app: 'manyaki', title: '', category: 'self', label: 'me', bounds: null, maximized: false, fullscreen: false, idleSeconds }
      } else {
        const app = w.owner.name || w.owner.path?.split(/[\\/]/).pop() || ''
        const c = classify(app, w.title, settings.categoryRules)
        const isGame = /\b(valorant|league of legends|minecraft|fortnite|apex|counter-?strike|cs2|dota|genshin|roblox|overwatch|gta|elden ring|pubg|rocket league|steam|epic games|riot client|osu|call of duty|warzone)\b/i.test(`${app} ${w.title}`)
        const category = isGame && settings.gamingIsWork ? 'work' : c.category
        const label = c.label
        // get-windows reports physical pixels; Electron's displays are in DIPs. Without this, a maximized
        // window on a 125% display looks "fullscreen" and she hides, and perches land in the wrong place.
        const b = process.platform === 'win32' ? screen.screenToDipRect(null, w.bounds) : w.bounds
        const display = screen.getDisplayMatching(b)
        const d = display.bounds
        const wa = display.workArea
        const isShell = /explorer|searchhost|shellexperiencehost|startmenuexperiencehost|lockapp/i.test(app)
        // A window covering the whole display (taskbar included) is a fullscreen game/video.
        const fullscreen = !isShell && b.x <= d.x && b.y <= d.y && b.x + b.width >= d.x + d.width && b.y + b.height >= d.y + d.height
        const maximized = !fullscreen && b.width >= wa.width - 2 && b.height >= wa.height - 2
        snap = {
          app,
          title: w.title,
          category,
          label,
          bounds: isShell ? null : { x: b.x, y: b.y, width: b.width, height: b.height },
          maximized,
          fullscreen,
          idleSeconds
        }
      }
      const key = JSON.stringify({ ...snap, idleSeconds: Math.floor(snap.idleSeconds / 15) })
      const now = Date.now()
      if (key !== last || now - lastSent > 15000) {
        last = key
        lastSent = now
        onChange(snap)
      }
    } catch {
      // get-windows can transiently fail (e.g. on the lock screen); try again next tick.
    } finally {
      busy = false
    }
  }

  const timer = setInterval(tick, 1000)
  void tick()
  return () => clearInterval(timer)
}
