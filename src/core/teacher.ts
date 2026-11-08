import * as THREE from 'three'
import type { Avatar } from './avatar'

/**
 * Her teaching outfit: round glasses and a little pointer stick with a star on the end. They pop in when a
 * lesson starts and pop away when it ends. Parented to the normalized head and hand, whose axes match
 * the model (faces +Z, her right hand is toward -X), so no per-model tuning is needed.
 */
export class TeacherProps {
  private readonly glasses = new THREE.Group()
  private readonly stick = new THREE.Group()
  private k = 0 // 0 hidden .. 1 shown
  private want = 0
  private t = 0

  constructor(avatar: Avatar) {
    const frame = new THREE.MeshBasicMaterial({ color: 0xff7aa8 })
    // Drawn over her face: its curve would otherwise swallow the middle of the frames.
    const rim = new THREE.MeshBasicMaterial({ color: 0xff7aa8, transparent: true, depthTest: false, depthWrite: false })
    const lens = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false })

    const head = avatar.bone('head')
    const lEye = avatar.rawBone('leftEye')
    const rEye = avatar.rawBone('rightEye')
    if (head) {
      head.updateWorldMatrix(true, false)
      const local = (o: THREE.Object3D | null, x: number) => {
        if (!o) return new THREE.Vector3(x, 0.06, 0.08)
        const v = new THREE.Vector3()
        o.getWorldPosition(v)
        return head.worldToLocal(v)
      }
      // Her eye bones sit deep in the head and close together, so they only give the height: the rest is
      // proportional to her size. shortcut: tuned on Manyaki.vrm, a very different face would need new numbers.
      const l = local(lEye, 0.03)
      const r = local(rEye, -0.03)
      const s = avatar.modelMetres / 1.5
      const radius = 0.024 * s
      const eyeX = 0.033 * s
      for (const x of [eyeX, -eyeX]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, radius * 0.13, 8, 28), rim)
        const glass = new THREE.Mesh(new THREE.CircleGeometry(radius, 28), lens)
        ring.position.x = x
        glass.position.x = x
        this.glasses.add(ring, glass)
      }
      const bridge = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.11, radius * 0.11, (eyeX - radius) * 2, 6), rim)
      bridge.rotation.z = Math.PI / 2
      bridge.position.y = radius * 0.3
      this.glasses.add(bridge)
      // Just in front of the face.
      this.glasses.position.set(0, (l.y + r.y) / 2 - 0.004 * s, Math.max(l.z, r.z) + 0.058 * s)
      this.glasses.traverse((o) => { o.renderOrder = 15 })
      head.add(this.glasses)
    }

    const hand = avatar.bone('rightHand')
    if (hand) {
      const s = avatar.modelMetres / 1.5
      const len = 0.2 * s
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.004 * s, 0.007 * s, len, 8), new THREE.MeshBasicMaterial({ color: 0x8a5a44 }))
      rod.rotation.z = Math.PI / 2 // along the arm, out past her fingers
      rod.position.x = -len / 2
      const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.022 * s), frame)
      tip.position.x = -len
      this.stick.add(rod, tip)
      this.stick.position.set(-0.05 * s, 0, 0.01 * s)
      hand.add(this.stick)
    }
    this.apply()
  }

  /** Popping in or out: worth drawing smoothly. */
  get animating() { return this.k !== this.want }

  show() { this.want = 1; this.t = 0 }
  hide() { this.want = 0; this.t = 0 }

  update(dt: number) {
    if (this.k === this.want) return
    this.t += dt
    const p = Math.min(1, this.t / (this.want ? 0.35 : 0.2))
    this.k = p >= 1 ? this.want : this.want ? easeOutBack(p) : 1 - p
    this.apply()
  }

  private apply() {
    const on = this.k > 0.001
    this.glasses.visible = this.stick.visible = on
    const s = Math.max(0.001, this.k)
    this.glasses.scale.setScalar(s)
    this.stick.scale.setScalar(s)
  }
}

function easeOutBack(x: number) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}
