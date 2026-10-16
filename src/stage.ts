import type { Bridge, DisplayInfo } from '../shared/types'
import { Avatar } from './core/avatar'
import { Motion } from './core/anim/motion'
import { Layers } from './core/anim/layers'
import { Expressions } from './core/expressions'
import { Blush, Emotes } from './core/fx'
import { Behavior } from './core/behavior'
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
  private acc = 0
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
    this.body = new Behavior(this.avatar, this.motion, this.layers, this.face, this.emotes)
    this.body.setDisplay(this.display)

    this.interactive.push(this.bubble.element, document.getElementById('chat')!, document.getElementById('debug')!)
    window.addEventListener('resize', () => this.resize())
    window.addEventListener('mousemove', (e) => this.onMove(e))
    window.addEventListener('mousedown', (e) => this.onDown(e))
    window.addEventListener('mouseup', (e) => this.onUp(e))
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

    requestAnimationFrame(this.loop)
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
    this.avatar?.resize(window.innerWidth, window.innerHeight)
  }

  private targetFps() {
    if (this.hiddenAlpha) return 8
    const m = this.body.mode
    if (this.body.conv !== 'none' || m === 'walk' || m === 'fall' || m === 'jump' || m === 'drag' || m === 'act' || m === 'land') return 60
    if (this.hover) return 60
    return 30
  }

  private readonly loop = (now: number) => {
    requestAnimationFrame(this.loop)
    const raw = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    this.acc += raw
    const step = 1 / this.targetFps()
    if (this.acc < step * 0.92) return
    const dt = Math.min(0.1, this.acc)
    this.acc = 0

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
    this.avatar.render()

    // Click-through: capture the mouse only over her pixels or our UI.
    const overHer = !this.hiddenAlpha && this.avatar.hitTest(this.cursorX, this.cursorY)
    if (overHer !== this.hover) {
      this.hover = overHer
      if (overHer) this.body.hoverSince = performance.now()
    }
    this.updateIgnore()

    const box = this.avatar.screenBox()
    const cx = box.left + (box.right - box.left) / 2
    this.bubble.place(cx, box.top)
    this.chip.place(cx, box.bottom - 26)
    const chat = document.getElementById('chat')!
    if (!chat.classList.contains('hidden')) {
      chat.style.left = `${Math.max(160, Math.min(window.innerWidth - 160, cx))}px`
      chat.style.top = `${Math.max(8, Math.min(window.innerHeight - 60, box.bottom - this.avatar.heightPx * 0.35))}px`
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

  private onMove(e: MouseEvent) {
    this.cursorX = e.clientX
    this.cursorY = e.clientY
    if (this.body) this.body.cursorMovedAt = performance.now()
    this.overUi = this.interactive.some((el) => !el.classList.contains('hidden') && el.contains(e.target as Node))
    if (this.pointerDown && !this.dragging) {
      if (Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y) > 6) {
        this.dragging = true
        this.body.grab(this.pointerDown.x, this.pointerDown.y)
        document.body.style.cursor = 'grabbing'
      }
    }
    if (this.dragging) this.body.dragTo(e.clientX, e.clientY)
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0 || !this.hover) return
    this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() }
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
    const zone: ClickZone = e.clientY < box.top + this.avatar.heightPx * 0.22 ? 'head' : 'body'
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
