import * as THREE from 'three'
import type { Avatar } from './avatar'

/** Soft pink cheek blush, parented to her head so it follows every motion. */
export class Blush {
  private readonly mat: THREE.MeshBasicMaterial
  private readonly group = new THREE.Group()

  constructor(avatar: Avatar) {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32)
    grad.addColorStop(0, 'rgba(255,110,140,0.85)')
    grad.addColorStop(0.55, 'rgba(255,120,150,0.35)')
    grad.addColorStop(1, 'rgba(255,130,160,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    this.mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })

    const head = avatar.rawBone('head')
    const lEye = avatar.rawBone('leftEye')
    const rEye = avatar.rawBone('rightEye')
    if (!head) return
    head.add(this.group)
    head.updateWorldMatrix(true, false)
    const local = (o: THREE.Object3D | null, fallbackX: number) => {
      if (!o) return new THREE.Vector3(fallbackX, 0.06, 0.08)
      const v = new THREE.Vector3()
      o.getWorldPosition(v)
      return head.worldToLocal(v)
    }
    const geo = new THREE.PlaneGeometry(0.05, 0.03)
    for (const [eye, side] of [[lEye, 1], [rEye, -1]] as const) {
      const p = local(eye, 0.03 * side)
      const m = new THREE.Mesh(geo, this.mat)
      // Just under and slightly outside each eye, pushed forward onto the cheek surface.
      m.position.set(p.x + 0.008 * side, p.y - 0.032, p.z + 0.028)
      m.renderOrder = 10
      this.group.add(m)
    }
  }

  set(amount: number) {
    this.mat.opacity = Math.max(0, Math.min(1, amount)) * 0.75
    this.group.visible = this.mat.opacity > 0.01
  }
}

const EMOTE_GLYPH: Record<string, string> = {
  heart: '💗', sparkle: '✨', anger: '💢', sleep: '💤', idea: '💡', question: '❓', party: '🎉',
  music: '🎵', sweat: '💦', star: '⭐', fire: '🔥', note: '📝', coffee: '☕', water: '💧'
}
export const EMOTES = Object.keys(EMOTE_GLYPH)

interface Live { sprite: THREE.Sprite; t: number; life: number; dx: number }

/** Little emoji that pop above her head. Lives in the 3D scene so it is part of the overlay render. */
export class Emotes {
  private readonly live: Live[] = []
  private readonly cache = new Map<string, THREE.SpriteMaterial>()

  constructor(private readonly avatar: Avatar) {}

  get active() { return this.live.length > 0 }

  pop(kind: string) {
    const glyph = EMOTE_GLYPH[kind] ?? kind
    let mat = this.cache.get(glyph)
    if (!mat) {
      const c = document.createElement('canvas')
      c.width = c.height = 96
      const g = c.getContext('2d')!
      g.font = '72px "Segoe UI Emoji", "Apple Color Emoji", sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(glyph, 48, 54)
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })
      this.cache.set(glyph, mat)
    }
    const sprite = new THREE.Sprite(mat.clone())
    sprite.renderOrder = 20
    this.avatar.scene.add(sprite)
    this.live.push({ sprite, t: 0, life: kind === 'sleep' ? 2.4 : 1.8, dx: (Math.random() - 0.5) * 0.3 })
  }

  update(dt: number) {
    const a = this.avatar
    const top = a.root.position
    const h = a.modelMetres
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i]
      e.t += dt
      const p = e.t / e.life
      const size = h * 0.2 * (p < 0.15 ? easeOutBack(p / 0.15) : 1)
      e.sprite.scale.set(size, size, 1)
      e.sprite.position.set(top.x + h * (0.22 + e.dx), top.y + h * (1.02 + p * 0.18), 5)
      ;(e.sprite.material as THREE.SpriteMaterial).opacity = p > 0.7 ? 1 - (p - 0.7) / 0.3 : 1
      if (p >= 1) {
        a.scene.remove(e.sprite)
        ;(e.sprite.material as THREE.SpriteMaterial).dispose()
        this.live.splice(i, 1)
      }
    }
  }
}

function easeOutBack(x: number) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}
