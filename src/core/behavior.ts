import type { ActivitySnapshot, DisplayInfo } from '../../shared/types'
import type { Avatar } from './avatar'
import type { Motion } from './anim/motion'
import type { Layers } from './anim/layers'
import { faceInfo, type Emotion, type Expressions } from './expressions'
import type { Emotes, Squash } from './fx'
import type { Laptop } from './laptop'

export type Action =
  | 'wave' | 'nod' | 'shake' | 'think' | 'cheer' | 'jump' | 'dance' | 'shy' | 'clap' | 'stretch' | 'pout' | 'headpat' | 'none'
export const ACTIONS: Action[] = ['wave', 'nod', 'shake', 'think', 'cheer', 'jump', 'dance', 'shy', 'clap', 'stretch', 'pout', 'headpat', 'none']

export type Conv = 'none' | 'listening' | 'thinking' | 'talking'
type Mode = 'stand' | 'walk' | 'sit' | 'sleep' | 'jump' | 'fall' | 'drag' | 'land' | 'act'

interface Platform { y: number; left: number; right: number; kind: 'floor' | 'perch' }

const GRAVITY = 2600 // px/s^2 at 260px height; scaled by her size
const HOLD_ACTIONS = new Set(['dance', 'think', 'shy', 'pout'])

/**
 * Where she is and what her body is doing. Owns position/physics on screen and picks the clip to play.
 * Conversation and the brain request actions; autonomy fills the quiet time with small life.
 */
export class Behavior {
  mode: Mode = 'fall'
  conv: Conv = 'none'
  focus = false
  dnd = false
  hidden = false
  /** Autonomous wandering/napping (the debug panel can switch it off to inspect poses). */
  autonomy = true
  x = 0
  y = -400
  private vx = 0
  private vy = 0
  private facing = 0
  private targetX = 0
  private walkSpeed = 0
  private nextThink = 2
  private display!: DisplayInfo
  private activity: ActivitySnapshot | null = null
  private perch: Platform | null = null
  private jumpFrom = { x: 0, y: 0 }
  private jumpTo = { x: 0, y: 0, platform: null as Platform | null }
  private jumpT = 0
  private dragOffset = { x: 0, y: 0 }
  private lastCursor = { x: 0, y: 0, t: 0 }
  private cursorVel = { x: 0, y: 0 }
  private actToken = 0
  private sleeping = false
  private idleClip = 'idle'
  private mood: Emotion = 'neutral'
  cursor = { x: 0, y: 0 }
  cursorMovedAt = -1e9
  private glanceT = 0
  private glance = { x: 0, y: 0 }
  private convLean = 0
  private convTilt = 0
  private moodT = 0
  hoverSince = 0
  onLanded?: (hard: boolean) => void
  squash?: Squash
  onWoke?: () => void

  constructor(
    private readonly avatar: Avatar,
    private readonly motion: Motion,
    private readonly layers: Layers,
    private readonly face: Expressions,
    private readonly emotes: Emotes
  ) {}

  private get s() { return this.avatar.heightPx / 260 }
  private get hipsPx() {
    const hips = this.avatar.vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? 0.85
    return hips * this.avatar.scale
  }

  setDisplay(d: DisplayInfo) {
    this.display = d
    if (this.y < -300) {
      // First appearance: drop in from above the screen, somewhere on the right side.
      const f = this.floor()
      this.x = f.left + (f.right - f.left) * (0.65 + Math.random() * 0.25)
      this.y = -this.avatar.heightPx * 1.2
      this.vx = 0
      this.vy = 0
      this.mode = 'fall'
    }
    this.x = Math.max(this.floor().left + 40, Math.min(this.x, this.floor().right - 40))
  }

  setActivity(a: ActivitySnapshot) {
    const wasOnPerch = this.onPerch()
    this.activity = a
    this.perch = this.perchFrom(a)
    if (!wasOnPerch) return
    // Sitting on a window that moved, closed, was minimised or went behind another: she falls off.
    const p = this.perch
    const stillHolds = p && Math.abs(p.y - this.y) < 4 && this.x >= p.left - 30 && this.x <= p.right + 30
    if (!stillHolds) {
      this.startFall(0, -200 * this.s)
      this.emotes.pop('sweat')
      this.face.set('surprised', 1200)
    }
  }

  private onPerch() {
    const f = this.floor()
    return Math.abs(this.y - f.y) > 4 && this.mode !== 'fall' && this.mode !== 'jump' && this.mode !== 'drag'
  }

  private floor(): Platform {
    const d = this.display
    return {
      y: d.workArea.y + d.workArea.height - d.bounds.y,
      left: d.workArea.x - d.bounds.x + 30,
      right: d.workArea.x - d.bounds.x + d.workArea.width - 30,
      kind: 'floor'
    }
  }

  private perchFrom(a: ActivitySnapshot): Platform | null {
    if (!a.bounds || a.maximized || a.fullscreen || a.category === 'self' || !this.display) return null
    const d = this.display.bounds
    const y = a.bounds.y - d.y
    const left = a.bounds.x - d.x + 60
    const right = a.bounds.x - d.x + a.bounds.width - 160 // keep clear of the window buttons
    if (right - left < 120 || y < this.avatar.heightPx * 0.7 || y > this.floor().y - this.avatar.heightPx * 0.5) return null
    return { y, left, right, kind: 'perch' }
  }

  /** The surface directly below a point, if any. */
  private platformBelow(x: number, y: number): Platform {
    const f = this.floor()
    const p = this.perch
    if (p && x >= p.left - 20 && x <= p.right + 20 && y <= p.y + 2) return p
    return f
  }

  // ---------- requests from the rest of the app ----------

  setConv(c: Conv) {
    if (c === this.conv) return
    this.conv = c
    if (c !== 'none') {
      if (this.sleeping) this.wake()
      if (this.mode === 'walk') this.toStand()
    }
    this.convLean = c === 'listening' ? 5 : 0
    this.convTilt = c === 'listening' ? 6 : c === 'thinking' ? -5 : 0
    if (this.mode === 'stand') this.applyIdleClip()
  }

  setMood(e: Emotion, intensity = 1) {
    this.mood = e
    this.face.set(e, 0, intensity)
    this.idleClip = faceInfo(e).idle
    if (this.mode === 'stand') this.applyIdleClip()
  }

  /** Her slow background mood (from the affect engine): a subtle resting face and a fitting idle loop. */
  setRestMood(e: Emotion, intensity: number) {
    this.face.setBase(e, intensity)
    if (this.mood === e) return
    this.mood = e
    this.idleClip = faceInfo(e).idle
    if (this.mode === 'stand' && this.conv === 'none') this.applyIdleClip()
  }

  /** Play a gesture. Held actions (dance, think, shy, pout) last `holdMs`. */
  async act(a: Action, holdMs = 4000) {
    if (a === 'none' || this.usingLaptop || this.mode === 'drag' || this.mode === 'fall' || this.mode === 'jump') return
    if (this.sleeping) this.wake()
    if (a === 'jump') {
      this.squash?.impulse(0.7)
      this.vy = -700 * this.s
      this.startFall(0, this.vy)
      return
    }
    const sitting = this.mode === 'sit'
    if (sitting && !['nod', 'shake', 'wave', 'think', 'shy', 'headpat'].includes(a)) return // keep it seated
    const token = ++this.actToken
    this.mode = 'act'
    if (a === 'headpat') this.face.eyesClosed = true
    if (HOLD_ACTIONS.has(a)) {
      this.motion.play(a, { fade: 0.3 })
      await new Promise((r) => setTimeout(r, holdMs))
    } else {
      await this.motion.once(sitting && a !== 'headpat' ? a : a, { fade: 0.2 })
    }
    if (a === 'headpat') this.face.eyesClosed = false
    if (token !== this.actToken || this.mode !== 'act') return
    if (sitting) this.toSit()
    else this.toStand()
  }

  walkTo(x: number) {
    if (this.mode === 'drag' || this.mode === 'fall' || this.mode === 'jump') return
    const p = this.onPerch() ? this.perch : this.floor()
    if (!p) return
    this.targetX = Math.max(p.left, Math.min(p.right, x))
    if (Math.abs(this.targetX - this.x) < 10) return
    if (this.sleeping) this.wake()
    this.mode = 'walk'
    const run = Math.abs(this.targetX - this.x) > 700 * this.s
    const mocap = this.motion.isMocap(run ? 'run' : 'walk')
    // Ground speed matched to the clip's stride so the feet don't skate.
    this.walkSpeed = (run ? 2.0 : 0.95) * (mocap ? 0.55 : 0.42) * this.avatar.heightPx
    this.motion.play(run ? 'run' : 'walk', { fade: 0.25 })
  }

  goCorner() {
    const f = this.floor()
    if (this.onPerch()) this.startFall(0, 0)
    else this.walkTo(f.right - 20)
  }

  sleep() {
    if (this.sleeping || this.mode === 'drag' || this.mode === 'fall' || this.mode === 'jump') return
    this.sleeping = true
    this.mode = 'sleep'
    this.face.set('sleepy')
    this.face.eyesClosed = true
    this.layers.lookWeight = 0
    this.motion.play(this.onPerch() ? 'sleep' : 'sleepFloor', { fade: 0.8 })
    this.emotes.pop('sleep')
  }

  wake() {
    if (!this.sleeping) return
    this.sleeping = false
    this.face.eyesClosed = false
    this.layers.lookWeight = 1
    this.face.set('surprised', 900)
    this.onWoke?.()
    if (this.onPerch()) this.toSit()
    else this.toStand()
  }

  /**
   * The "do something on the computer" routine: she stops, pulls out her little laptop, types while
   * `work` runs, shows the result on its screen and puts it away.
   */
  async useLaptop(laptop: Laptop, label: string, icon: string, work: () => Promise<boolean>, doneFace: Emotion = 'happy'): Promise<boolean> {
    if (this.sleeping) this.wake()
    if (this.mode === 'walk' || this.mode === 'sit') this.toStand()
    const canAnimate = !this.isBusy && !laptop.busy
    if (!canAnimate) return work()
    const token = ++this.actToken
    this.mode = 'act'
    this.usingLaptop = true
    this.layers.lookWeight = 0.2
    this.motion.play('typing', { fade: 0.25 })
    laptop.begin(label, icon)
    this.emotes.pop(doneFace === 'happy' ? 'sparkle' : 'anger')
    // Let the pop-in and lid animation play before the real work, so it reads as cause and effect.
    const [ok] = await Promise.all([work().catch(() => false), new Promise((r) => setTimeout(r, 1300))])
    laptop.finish(ok)
    this.face.set(ok ? doneFace : 'worried', 2500)
    await new Promise((r) => setTimeout(r, 1100))
    this.usingLaptop = false
    this.layers.lookWeight = 1
    if (token === this.actToken && this.mode === 'act') {
      if (ok) void this.act(doneFace === 'happy' ? 'nod' : 'pout')
      else this.toStand()
    }
    return ok
  }

  private usingLaptop = false

  get isSleeping() { return this.sleeping }
  get isBusy() { return this.mode === 'drag' || this.mode === 'fall' || this.mode === 'jump' || this.mode === 'land' }

  // ---------- pointer ----------

  grab(cx: number, cy: number) {
    if (this.sleeping) this.wake()
    this.squash?.impulse(0.5)
    this.mode = 'drag'
    this.dragOffset = { x: this.x - cx, y: this.y - cy }
    this.lastCursor = { x: cx, y: cy, t: performance.now() }
    this.motion.play('dangle', { fade: 0.15 })
    this.face.set('surprised', 800)
    this.layers.lookWeight = 0.4
  }

  dragTo(cx: number, cy: number) {
    if (this.mode !== 'drag') return
    const now = performance.now()
    const dt = Math.max(1, now - this.lastCursor.t) / 1000
    this.cursorVel = { x: (cx - this.lastCursor.x) / dt, y: (cy - this.lastCursor.y) / dt }
    this.lastCursor = { x: cx, y: cy, t: now }
    // Keep her on screen: the taskbar line is solid ground, she can't be pushed through it.
    const f = this.floor()
    this.x = clamp(cx + this.dragOffset.x, f.left, f.right)
    this.y = clamp(cy + this.dragOffset.y, this.avatar.heightPx * 0.4, f.y)
  }

  /** Put her back on the taskbar, standing, visible, whatever state she was in. */
  reset() {
    const f = this.floor()
    this.sleeping = false
    this.face.eyesClosed = false
    this.layers.lookWeight = 1
    this.vx = 0
    this.vy = 0
    this.usingLaptop = false
    this.actToken++
    this.x = f.left + (f.right - f.left) * 0.8
    this.y = f.y
    this.conv = 'none'
    this.toStand()
  }

  release() {
    if (this.mode !== 'drag') return
    this.layers.lookWeight = 1
    const stale = performance.now() - this.lastCursor.t > 80
    this.startFall(stale ? 0 : clamp(this.cursorVel.x * 0.5, -1500, 1500), stale ? 0 : clamp(this.cursorVel.y * 0.4, -1400, 600))
  }

  // ---------- internals ----------

  private startFall(vx: number, vy: number) {
    this.sleeping = false
    this.face.eyesClosed = false
    this.mode = 'fall'
    this.vx = vx
    this.vy = vy
    this.motion.play('fall', { fade: 0.15 })
  }

  private jumpOnto(p: Platform, x: number) {
    this.mode = 'jump'
    this.jumpFrom = { x: this.x, y: this.y }
    this.jumpTo = { x, y: p.y, platform: p }
    this.jumpT = 0
    this.squash?.impulse(0.8)
    void this.motion.once('jump', { fade: 0.15, speed: 1.2 })
    this.emotes.pop('sparkle')
  }

  private toStand() {
    this.mode = 'stand'
    this.applyIdleClip()
  }

  private toSit() {
    this.mode = 'sit'
    this.motion.play(this.onPerch() ? 'sit' : 'sitFloor', { fade: 0.4 })
  }

  private applyIdleClip() {
    const clip = this.conv === 'listening' ? 'listen' : this.conv === 'thinking' ? 'think' : this.conv === 'talking' ? 'talk' : this.idleClip
    this.motion.play(clip, { fade: 0.35 })
  }

  private land(hard: boolean) {
    // Squash in proportion to how fast she hit the ground.
    this.squash?.impulse(-Math.min(1, 0.35 + Math.max(0, this.vy) / (2200 * this.s)))
    this.vx = 0
    this.vy = 0
    this.mode = 'land'
    void this.motion.once('land', { fade: 0.1 }).then(() => {
      if (this.mode !== 'land') return
      const onPerch = this.onPerch()
      if (onPerch) this.toSit()
      else this.toStand()
    })
    this.onLanded?.(hard)
  }

  update(dt: number) {
    if (!this.display) return
    const s = this.s
    const f = this.floor()

    switch (this.mode) {
      case 'fall': {
        const prevY = this.y
        this.vy += GRAVITY * s * dt
        this.vx *= Math.exp(-dt * 0.8)
        this.x += this.vx * dt
        this.y += this.vy * dt
        // Bounce off the screen edges instead of flying off.
        if (this.x < f.left) { this.x = f.left; this.vx = Math.abs(this.vx) * 0.4 }
        if (this.x > f.right) { this.x = f.right; this.vx = -Math.abs(this.vx) * 0.4 }
        const p = this.platformBelow(this.x, prevY)
        if (this.vy > 0 && this.y >= p.y && prevY <= p.y + 1) {
          this.y = p.y
          this.land(this.vy > 1400 * s)
        } else if (this.y >= f.y) {
          // Already at/below the taskbar line (e.g. dropped low): the floor is solid, land on it.
          this.y = f.y
          this.land(this.vy > 1400 * s)
        }
        break
      }
      case 'jump': {
        this.jumpT += dt / 0.75
        const t = Math.min(1, this.jumpT)
        const peak = Math.min(this.jumpFrom.y, this.jumpTo.y) - 90 * s
        this.x = lerp(this.jumpFrom.x, this.jumpTo.x, t)
        // Quadratic Bezier through the peak.
        const a = this.jumpFrom.y
        const c = this.jumpTo.y
        this.y = (1 - t) * (1 - t) * a + 2 * (1 - t) * t * peak + t * t * c
        if (t >= 1) {
          this.y = this.jumpTo.y
          this.land(false)
        }
        break
      }
      case 'walk': {
        const dir = Math.sign(this.targetX - this.x)
        this.x += dir * this.walkSpeed * dt
        this.facing = dir * 1.15
        if ((dir > 0 && this.x >= this.targetX) || (dir < 0 && this.x <= this.targetX) || dir === 0) {
          this.x = this.targetX
          this.toStand()
        }
        break
      }
      default:
        break
    }

    // Safety net: never let her end up off-screen or inside the taskbar.
    if (this.mode !== 'drag' && this.mode !== 'fall' && this.mode !== 'jump') {
      if (!Number.isFinite(this.x) || !Number.isFinite(this.y) || this.y > f.y + 2 || this.x < f.left - 50 || this.x > f.right + 50) {
        this.x = Number.isFinite(this.x) ? clamp(this.x, f.left, f.right) : f.right
        this.y = f.y
      }
    }

    // Facing: sideways while walking/falling with speed, otherwise turned toward the viewer.
    const wantFacing = this.mode === 'walk' ? this.facing : this.mode === 'fall' && Math.abs(this.vx) > 200 ? Math.sign(this.vx) * 0.7 : this.mode === 'sit' || this.mode === 'sleep' ? 0.25 * Math.sign(this.display.bounds.width / 2 - this.x) : 0
    this.avatar.root.rotation.y += (wantFacing - this.avatar.root.rotation.y) * (1 - Math.exp(-dt * 8))

    // Sitting puts her hips on the edge rather than her feet. On the floor her legs go forward, so she sinks less.
    const clip = this.motion.current
    const edge = clip === 'sit' || clip === 'sleep'
    const ground = clip === 'sitFloor' || clip === 'sleepFloor'
    const sitting = this.mode === 'sit' || this.mode === 'sleep' || this.mode === 'act'
    this.avatar.setFeet(this.x, this.y + (sitting && edge ? this.hipsPx * 0.92 : sitting && ground ? this.hipsPx * 0.55 : 0))

    // Body language from her face: tilt and lean add to the conversation pose.
    const pose = this.face.pose
    this.layers.lean = this.convLean + pose.lean
    this.layers.tilt = this.convTilt + pose.tilt
    // Some emotions make her look away (shy, jealous, lonely); she peeks back every few seconds.
    this.moodT += dt
    const peek = Math.sin(this.moodT * 0.8) > 0.75
    const awayX = peek ? 0 : pose.glanceX * this.avatar.heightPx * 2 * (this.facing < 0 ? -1 : 1)
    const awayY = peek ? 0 : pose.glanceY * this.avatar.heightPx * 2

    // Gaze: whoever is talking to her gets eye contact; otherwise she follows the cursor.
    if (awayX || awayY) {
      this.layers.target.x = this.x + awayX
      this.layers.target.y = this.y - this.avatar.heightPx * 0.9 + awayY
    } else if (this.conv !== 'none') {
      this.layers.target.x = this.x
      this.layers.target.y = this.y - this.avatar.heightPx * 0.9
    } else if (performance.now() - this.cursorMovedAt < 15000) {
      this.layers.target.x = this.cursor.x
      this.layers.target.y = this.cursor.y
    } else {
      // Cursor hasn't moved: look out at the viewer, with an occasional glance around.
      this.glanceT -= dt
      if (this.glanceT <= 0) {
        this.glanceT = 2 + Math.random() * 5
        const away = Math.random() < 0.35
        this.glance = away ? { x: (Math.random() - 0.5) * 600 * s, y: (Math.random() - 0.6) * 200 * s } : { x: 0, y: 0 }
      }
      this.layers.target.x = this.x + this.glance.x
      this.layers.target.y = this.y - this.avatar.heightPx * 0.9 + this.glance.y
    }

    if (this.autonomy) this.think(dt)
  }

  /** Small life when nothing else is happening. */
  private think(dt: number) {
    this.nextThink -= dt
    if (this.nextThink > 0) return
    this.nextThink = 4 + Math.random() * 8
    if (this.conv !== 'none' || this.isBusy || this.mode === 'act' || this.mode === 'walk' || this.hidden) return

    const a = this.activity
    const idleSec = a?.idleSeconds ?? 0
    const hour = new Date().getHours()
    const late = hour >= 1 && hour < 6

    // You've been away: she naps. Returning wakes her (see onActivity in the app).
    if (idleSec > 300 || (late && Math.random() < 0.3)) {
      if (!this.sleeping) this.sleep()
      else if (Math.random() < 0.5) this.emotes.pop('sleep')
      return
    }
    if (this.sleeping) return

    const f = this.floor()
    const r = Math.random()
    if (this.focus || this.dnd) {
      // Focus: settle on top of the window you're working in and watch quietly.
      if (this.perch && !this.onPerch() && r < 0.35) {
        this.jumpOnto(this.perch, clamp(this.x, this.perch.left, this.perch.right))
      } else if (this.mode === 'stand' && r < 0.5) {
        this.toSit()
      } else if (this.mode === 'sit' && r < 0.08) {
        void this.act('stretch')
      }
      return
    }

    if (this.mode === 'sit' && r < 0.55) return // happy to keep sitting for a while
    if (this.mode === 'sit') {
      if (this.onPerch()) this.startFall(0, -300 * this.s)
      else this.toStand()
      return
    }

    if (r < 0.38) {
      const span = this.onPerch() && this.perch ? this.perch : f
      this.walkTo(span.left + Math.random() * (span.right - span.left))
    } else if (r < 0.52 && this.perch && !this.onPerch()) {
      this.jumpOnto(this.perch, this.perch.left + Math.random() * (this.perch.right - this.perch.left))
    } else if (r < 0.64) {
      this.toSit()
    } else if (r < 0.74) {
      void this.act((['stretch', 'dance', 'wave', 'clap'] as Action[])[Math.floor(Math.random() * 4)], 3500)
    } else if (r < 0.8) {
      this.emotes.pop((['music', 'sparkle', 'heart', 'star'])[Math.floor(Math.random() * 4)])
    }
    // else: just stand and breathe
  }

  get moodNow() { return this.mood }
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
