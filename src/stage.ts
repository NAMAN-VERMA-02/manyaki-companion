import type { Bridge, DisplayInfo } from '../shared/types'
import { Avatar } from './core/avatar'
import { Motion } from './core/anim/motion'
import { Layers } from './core/anim/layers'
import { Expressions } from './core/expressions'
import { Blush, Emotes } from './core/fx'
import { Behavior } from './core/behavior'
import { Laptop } from './core/laptop'
import { Bubble, StatusChip } from './ui/bubble'

export type ClickZone = 'head' | 'body'

/**
 * Everything visual: the render loop, her body, pointer handling and click-through.
 * The companion logic (voice, brain, motivation) drives it from the outside.
 */
export class Stage {
  avatar!: Avatar
  motion!: Motion
  layers!: Layers
  face!: Expressions
  blush!: Blush
  emotes!: Emotes
  laptop!: Laptop
  body!: Behavior
  readonly bubble = new Bubble()
  readonly chip = new StatusChip()
  display!: DisplayInfo
  /** Called with a click zone after a short click on her (not a drag). */
  onClick?: (zone: ClickZone, count: number) => void
  onDoubleClick?: () => void
  /** Per-frame hook (lip-sync, timers). */
  onFrame?: (dt: number) => void
  fps = 0
  private ignoring = true
  private pointerDown: { x: number; y: number; t: number } | null = null
  private dragging = false
  private hover = false
  private clickCount = 0
  private clickTimer = 0
  private last = performance.now()
  private frames = 0
  private fpsT = 0
  private hiddenAlpha = false
  /** UI elements that should capture the mouse when hovered. */
  private readonly interactive: HTMLElement[] = []

  constructor(private readonly bridge: Bridge, private readonly canvas: HTMLCanvasElement) {}

  async init(onProgress: (p: number) => void) {
    this.display = await this.bridge.getDisplay()
    const settings = await this.bridge.getSettings()
    this.avatar = new Avatar(this.canvas)
    this.avatar.heightPx = settings.size
    this.resize()
    await this.avatar.load('manyaki-asset://models/Manyaki.vrm', onProgress)
    this.motion = new Motion(this.avatar.vrm)
    this.layers = new Layers(this.avatar)
    this.face = new Expressions(this.avatar.vrm)
    this.blush = new Blush(this.avatar)
    this.emotes = new Emotes(this.avatar)
    this.laptop = new Laptop(this.avatar)
    this.body = new Behavior(this.avatar, this.motion, this.layers, this.face, this.emotes)
    this.body.setDisplay(this.display)

    this.interactive.push(this.bubble.element, document.getElementById('chat')!, document.getElementById('debug')!)
    window.addEventListener('resize', () => this.resize())
    window.addEventListener('mousemove', (e) => this.onMove(e))
    window.addEventListener('mousedown', (e) => this.onDown(e))
    window.addEventListener('mouseup', (e) => this.onUp(e))
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.hover) this.bridge.showMenu()
    })
    this.bridge.on('cursor', (p) => {
      if (p.x === this.cursorX && p.y === this.cursorY) return
      this.cursorX = p.x
      this.cursorY = p.y
      this.body.cursorMovedAt = performance.now()
    })
    this.bridge.on('display', (d) => {
      this.display = d
      this.resize()
      this.body.setDisplay(d)
    })

    // Mocap clips the user supplied replace the procedural ones as they finish loading.
    void this.bridge.listAnims().then(async (urls) => {
      if (!urls.length) return
      const n = await this.motion.loadUserClips(urls, (m) => this.bridge.log('warn', m))
      this.bridge.log('info', `loaded ${n}/${urls.length} mocap clips`)
    })

    this.schedule()
  }

  setSize(px: number) {
    this.avatar.setHeight(px)
  }

  /** Fade her out (fullscreen app, DND hide) without stopping the simulation. */
  setHidden(hidden: boolean) {
    if (hidden === this.hiddenAlpha) return
    this.hiddenAlpha = hidden
    this.body.hidden = hidden
    this.canvas.classList.toggle('faded', hidden)
    if (hidden) this.bubble.hide()
  }

  private resize() {
    if (!this.avatar) return
    this.avatar.setDisplayHeight(this.display.bounds.height)
    if (!this.bridge.followWindow) this.avatar.setView(0, 0, window.innerWidth, window.innerHeight)
  }

  private lastRect = { x: NaN, y: NaN, width: 0, height: 0 }

  /** Keep the (small) window wrapped around her, the bubble, emotes and the chat box. */
  private followWindow() {
    const a = this.avatar
    const box = a.screenBox()
    const cx = (box.left + box.right) / 2
    const bubbleOn = this.bubble.visible
    const chatOn = !document.getElementById('chat')!.classList.contains('hidden')
    const bw = bubbleOn ? this.bubble.element.offsetWidth + 40 : 0
    const bh = bubbleOn ? this.bubble.element.offsetHeight + 24 : 0
    const width = quant(Math.max(box.right - box.left + a.heightPx * 0.5, bw, chatOn ? 360 : 0, 220), 32)
    const top = box.top - Math.max(bh, a.heightPx * 0.32) - 8
    const floor = this.display.workArea.y + this.display.workArea.height - this.display.bounds.y
    const bottom = Math.min(floor, box.bottom + 32)
    const height = quant(bottom - top, 32)
    const want = { x: Math.round(cx - width / 2), y: Math.round(bottom - height), width, height }
    const r = this.lastRect
    if (want.x === r.x && want.y === r.y && want.width === r.width && want.height === r.height) return
    this.lastRect = want
    const got = this.bridge.setWindowRect(want)
    this.avatar.setView(got.x, got.y, got.width, got.height)
  }

  private targetFps() {
    // Each frame costs CPU on a transparent window, so the rate follows what she is doing.
    // Measured on an Intel UHD laptop: ~4% of one core per frame-per-second.
    if (this.hiddenAlpha) return 2
    const m = this.body.mode
    if (m === 'walk' || m === 'fall' || m === 'jump' || m === 'drag' || m === 'land') return 60
    if (this.body.conv === 'talking' || m === 'act') return 30
    if (this.laptop.busy) return 30
    if (this.body.conv !== 'none' || this.hover || this.emotes.active || this.face.animating) return 24
    if (m === 'sleep') return 6
    if (m === 'sit') return 10
    return 12
  }

  /**
   * Frames are paced by a timer at the target rate and then aligned to vsync with one rAF, instead of
   * waking at 60 Hz and skipping: idle wake-ups are what cost CPU on a transparent window.
   */
  private schedule() {
    const wait = Math.max(0, 1000 / this.targetFps() - (performance.now() - this.last) - 2)
    setTimeout(() => requestAnimationFrame(this.loop), wait)
  }

  private readonly loop = (now: number) => {
    const dt = Math.min(0.1, Math.max(0.001, (now - this.last) / 1000))
    this.last = now
    this.schedule()

    this.frames++
    this.fpsT += dt
    if (this.fpsT >= 1) { this.fps = Math.round(this.frames / this.fpsT); this.frames = 0; this.fpsT = 0 }

    this.onFrame?.(dt)
    this.body.cursor.x = this.cursorX
    this.body.cursor.y = this.cursorY
    this.body.update(dt)
    this.layers.restore()
    this.motion.update(dt)
    this.layers.apply(dt)
    this.face.update(dt)
    this.blush.set(this.face.blush)
    this.avatar.vrm.update(dt)
    this.emotes.update(dt)
    this.laptop.update(dt)
    if (this.bridge.followWindow) this.followWindow()
    this.avatar.render()

    // Click-through: capture the mouse only over her pixels or our UI.
    const overHer = !this.hiddenAlpha && this.avatar.hitTest(this.cursorX, this.cursorY)
    if (overHer !== this.hover) {
      this.hover = overHer
      if (overHer) this.body.hoverSince = performance.now()
    }
    this.updateIgnore()

    // DOM overlays are positioned in window coordinates.
    const v = this.avatar.view
    const box = this.avatar.screenBox()
    const cx = box.left + (box.right - box.left) / 2 - v.x
    this.bubble.place(cx, box.top - v.y)
    this.chip.place(cx, box.bottom - 26 - v.y)
    const chat = document.getElementById('chat')!
    if (!chat.classList.contains('hidden')) {
      chat.style.left = `${Math.max(170, Math.min(window.innerWidth - 170, cx))}px`
      chat.style.top = `${Math.max(8, Math.min(window.innerHeight - 60, box.bottom - this.avatar.heightPx * 0.35 - v.y))}px`
    }
  }

  private cursorX = -1000
  private cursorY = -1000
  private overUi = false

  private updateIgnore() {
    const capture = this.hover || this.overUi || this.dragging || !!this.pointerDown
    if (capture === !this.ignoring) return
    this.ignoring = !capture
    this.bridge.setIgnoreMouse(this.ignoring)
    document.body.style.cursor = capture && this.hover ? 'grab' : ''
  }

  /** Mouse event -> display coordinates. */
  private pt(e: MouseEvent) {
    return { x: e.clientX + this.avatar.view.x, y: e.clientY + this.avatar.view.y }
  }

  private onMove(e: MouseEvent) {
    const p = this.pt(e)
    this.cursorX = p.x
    this.cursorY = p.y
    if (this.body) this.body.cursorMovedAt = performance.now()
    this.overUi = this.interactive.some((el) => !el.classList.contains('hidden') && el.contains(e.target as Node))
    if (this.pointerDown && !this.dragging) {
      if (Math.hypot(p.x - this.pointerDown.x, p.y - this.pointerDown.y) > 6) {
        this.dragging = true
        this.body.grab(this.pointerDown.x, this.pointerDown.y)
        document.body.style.cursor = 'grabbing'
      }
    }
    if (this.dragging) this.body.dragTo(p.x, p.y)
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0 || !this.hover) return
    const p = this.pt(e)
    this.pointerDown = { x: p.x, y: p.y, t: performance.now() }
  }

  private onUp(e: MouseEvent) {
    if (e.button !== 0) return
    const down = this.pointerDown
    this.pointerDown = null
    if (this.dragging) {
      this.dragging = false
      this.body.release()
      return
    }
    if (!down) return
    // Head = the top ~22% of her height.
    const box = this.avatar.screenBox()
    const zone: ClickZone = this.pt(e).y < box.top + this.avatar.heightPx * 0.22 ? 'head' : 'body'
    this.clickCount++
    clearTimeout(this.clickTimer)
    if (this.clickCount === 2) {
      this.clickCount = 0
      this.onDoubleClick?.()
      return
    }
    this.clickTimer = window.setTimeout(() => {
      const n = this.clickCount
      this.clickCount = 0
      this.onClick?.(zone, n)
    }, 260)
    this.rapid.push(performance.now())
    this.rapid = this.rapid.filter((t) => performance.now() - t < 2500)
  }

  rapid: number[] = []
}

const quant = (v: number, step: number) => Math.ceil(v / step) * step
