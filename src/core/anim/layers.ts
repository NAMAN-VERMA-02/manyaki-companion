import * as THREE from 'three'
import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import type { Avatar } from '../avatar'

const LAYER_BONES: VRMHumanBoneName[] = ['spine', 'chest', 'upperChest', 'neck', 'head']
const D = THREE.MathUtils.DEG2RAD

/**
 * Procedural layers applied on top of whatever clip is playing: breathing, head/eye tracking,
 * a listening lean and a cute head tilt. Bones the current clip does not animate keep their last value
 * in THREE's mixer, so we restore the pre-layer pose each frame to avoid the offsets compounding.
 */
export class Layers {
  /** Screen point she is interested in (cursor, active window, user's face ≈ screen centre). */
  readonly target = { x: 0, y: 0 }
  lookWeight = 1
  lean = 0
  tilt = 0
  private curLook = 1
  private curLean = 0
  private curTilt = 0
  private yaw = 0
  private pitch = 0
  private t = 0
  private readonly saved = new Map<VRMHumanBoneName, THREE.Quaternion>()
  private readonly lookTarget = new THREE.Object3D()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()

  constructor(private readonly avatar: Avatar) {
    avatar.scene.add(this.lookTarget)
    avatar.vrm.lookAt && (avatar.vrm.lookAt.target = this.lookTarget)
    for (const b of LAYER_BONES) {
      const node = avatar.bone(b)
      if (node) this.saved.set(b, node.quaternion.clone())
    }
  }

  /** Call before mixer.update(). */
  restore() {
    for (const [b, q] of this.saved) this.avatar.bone(b)?.quaternion.copy(q)
  }

  /** Call after mixer.update() and before vrm.update(). */
  apply(dt: number) {
    this.t += dt
    for (const [b, q] of this.saved) {
      const node = this.avatar.bone(b)
      if (node) q.copy(node.quaternion)
    }
    const k = 1 - Math.exp(-dt * 6)
    this.curLook += (this.lookWeight - this.curLook) * k
    this.curLean += (this.lean - this.curLean) * k
    this.curTilt += (this.tilt - this.curTilt) * k

    // Head position on screen (approximate from the feet + height so it is stable even mid-clip).
    const a = this.avatar
    const feet = a.toScreen(a.root.position)
    const headX = feet.x
    const headY = feet.y - a.heightPx * 0.9
    const dx = this.target.x - headX
    const dy = headY - this.target.y
    const span = Math.max(300, a.heightPx * 2.5)
    const facing = a.root.rotation.y
    const wantYaw = THREE.MathUtils.clamp(Math.atan2(dx, span) - facing * 0.8, -0.8, 0.8)
    const wantPitch = THREE.MathUtils.clamp(Math.atan2(dy, span), -0.5, 0.45)
    this.yaw += (wantYaw - this.yaw) * k
    this.pitch += (wantPitch - this.pitch) * k

    const breathe = Math.sin(this.t * 1.6)
    this.offset('chest', breathe * 1.4 * D, 0, 0)
    this.offset('upperChest', breathe * 0.8 * D, 0, 0)
    this.offset('spine', this.curLean * D, 0, 0)
    const w = this.curLook
    this.offset('neck', -this.pitch * 0.35 * w, this.yaw * 0.4 * w, 0)
    this.offset('head', -this.pitch * 0.55 * w, this.yaw * 0.6 * w, this.curTilt * D + Math.sin(this.t * 0.7) * 1.2 * D)

    // Eyes follow even when the head can't (e.g. while asleep the weight is 0 and eyes are closed anyway).
    a.toWorld(this.target.x, this.target.y, a.modelMetres * 1.6, this.lookTarget.position)
  }

  private offset(b: VRMHumanBoneName, x: number, y: number, z: number) {
    const node = this.avatar.bone(b)
    if (!node || (x === 0 && y === 0 && z === 0)) return
    this.e.set(x, y, z, 'YXZ')
    node.quaternion.multiply(this.q.setFromEuler(this.e))
  }
}
