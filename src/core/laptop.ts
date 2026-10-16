import * as THREE from 'three'
import type { Avatar } from './avatar'

type Phase = 'hidden' | 'appearing' | 'opening' | 'working' | 'done' | 'closing' | 'vanishing'

/**
 * A tiny pink laptop she pulls out to "do" things on the computer: it pops in, the lid opens, the screen
 * shows what she's opening with a progress bar, then a ✓ (or ✗), and it folds away again.
 * Built from primitives, parented to her root so it follows her around and turns with her.
 */
export class Laptop {
  private readonly group = new THREE.Group()
  private readonly lidPivot = new THREE.Group()
  private readonly screenCanvas = document.createElement('canvas')
  private readonly screenTex: THREE.CanvasTexture
  private phase: Phase = 'hidden'
  private t = 0
  private label = ''
  private icon = '💻'
  private progress = 0
  private result: 'ok' | 'fail' | null = null
  private lastDrawn = ''

  constructor(avatar: Avatar) {
    const h = avatar.modelMetres
    const s = h / 1.5 // sized for a ~1.5 m model
    const body = new THREE.MeshToonMaterial({ color: 0xffb3cf })
    const dark = new THREE.MeshBasicMaterial({ color: 0x3b2340 })

    // Base with a keyboard deck.
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.26 * s, 0.014 * s, 0.18 * s), body)
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(0.22 * s, 0.1 * s), dark)
    deck.rotation.x = -Math.PI / 2
    deck.position.set(0, 0.0075 * s, 0.02 * s)
    base.add(deck)
    this.group.add(base)

    // Lid hinged at the far edge of the base (away from her, toward the viewer): the screen faces her and
    // the viewer sees the pink back of the lid with its heart sticker.
    this.lidPivot.position.set(0, 0.007 * s, 0.09 * s)
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.26 * s, 0.17 * s, 0.008 * s), body)
    lid.position.set(0, 0.085 * s, 0)
    this.lidPivot.add(lid)

    // Screen faces her; the viewer sees the back of the lid with a little heart sticker.
    this.screenCanvas.width = 256
    this.screenCanvas.height = 168
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas)
    this.screenTex.colorSpace = THREE.SRGBColorSpace
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.24 * s, 0.15 * s), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }))
    screen.position.set(0, 0.085 * s, -0.0045 * s)
    screen.rotation.y = Math.PI
    this.lidPivot.add(screen)

    const sticker = document.createElement('canvas')
    sticker.width = sticker.height = 64
    const g = sticker.getContext('2d')!
    g.font = '52px "Segoe UI Emoji", sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('💗', 32, 36)
    const stex = new THREE.CanvasTexture(sticker)
    stex.colorSpace = THREE.SRGBColorSpace
    const heart = new THREE.Mesh(new THREE.PlaneGeometry(0.06 * s, 0.06 * s), new THREE.MeshBasicMaterial({ map: stex, transparent: true }))
    heart.position.set(0, 0.09 * s, 0.0045 * s)
    this.lidPivot.add(heart)
    this.group.add(this.lidPivot)

    // Held in front of her at hand height, tilted slightly toward the viewer so the action reads.
    this.group.position.set(0, 0.6 * h, 0.2 * s)
    this.group.rotation.x = 0.15
    this.group.visible = false
    this.group.scale.setScalar(0.001)
    avatar.root.add(this.group)
    this.setLid(0)
  }

  get busy() { return this.phase !== 'hidden' }

  /** Starts the routine; resolves once the lid is open and she is "typing". */
  begin(label: string, icon: string) {
    this.label = label
    this.icon = icon
    this.progress = 0
    this.result = null
    this.phase = 'appearing'
    this.t = 0
    this.group.visible = true
    this.draw()
  }

  /** Shows the result on screen, then folds up and vanishes. */
  finish(ok: boolean) {
    this.result = ok ? 'ok' : 'fail'
    this.progress = 1
    this.phase = 'done'
    this.t = 0
    this.draw()
  }

  update(dt: number) {
    if (this.phase === 'hidden') return
    this.t += dt
    const p = this.phase
    if (p === 'appearing') {
      this.group.scale.setScalar(easeOutBack(Math.min(1, this.t / 0.3)))
      if (this.t >= 0.3) this.next('opening')
    } else if (p === 'opening') {
      this.setLid(Math.min(1, this.t / 0.35))
      if (this.t >= 0.35) this.next('working')
    } else if (p === 'working') {
      // Fake progress that slows near the end until the real result arrives.
      this.progress = Math.min(0.92, this.progress + dt * (1 - this.progress) * 1.6)
      this.draw()
    } else if (p === 'done') {
      if (this.t >= 0.9) this.next('closing')
    } else if (p === 'closing') {
      this.setLid(1 - Math.min(1, this.t / 0.3))
      if (this.t >= 0.3) this.next('vanishing')
    } else if (p === 'vanishing') {
      this.group.scale.setScalar(Math.max(0.001, 1 - this.t / 0.2))
      if (this.t >= 0.2) {
        this.group.visible = false
        this.phase = 'hidden'
      }
    }
  }

  private next(p: Phase) {
    this.phase = p
    this.t = 0
  }

  private setLid(open: number) {
    // Closed = folded flat over the keyboard (toward her); open = upright, tilted slightly away from her.
    this.lidPivot.rotation.x = THREE.MathUtils.lerp(-Math.PI / 2, 0.22, open)
  }

  private draw() {
    const key = `${this.label}|${Math.round(this.progress * 40)}|${this.result}`
    if (key === this.lastDrawn) return
    this.lastDrawn = key
    const c = this.screenCanvas
    const g = c.getContext('2d')!
    const grad = g.createLinearGradient(0, 0, 0, c.height)
    grad.addColorStop(0, '#2b1838')
    grad.addColorStop(1, '#4b2150')
    g.fillStyle = grad
    g.fillRect(0, 0, c.width, c.height)
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = '44px "Segoe UI Emoji", sans-serif'
    g.fillText(this.result === 'ok' ? '✅' : this.result === 'fail' ? '❌' : this.icon, c.width / 2, 52)
    g.fillStyle = '#ffe3ee'
    g.font = '600 18px "Segoe UI", sans-serif'
    const text = this.label.length > 22 ? this.label.slice(0, 21) + '…' : this.label
    g.fillText(text, c.width / 2, 104)
    g.fillStyle = 'rgba(255,255,255,0.18)'
    roundRect(g, 32, 128, c.width - 64, 12, 6)
    g.fillStyle = this.result === 'fail' ? '#ff6b81' : '#ff7aa8'
    roundRect(g, 32, 128, (c.width - 64) * this.progress, 12, 6)
    this.screenTex.needsUpdate = true
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (w <= 0) return
  g.beginPath()
  g.roundRect(x, y, w, h, Math.min(r, w / 2))
  g.fill()
}

function easeOutBack(x: number) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}
