import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

// Hand-authored fallback clips, used for any motion the user has not supplied a Mixamo/VRMA clip for.
// Conventions (VRM 1.0 normalized bones, model faces +Z, her left = +X), degrees:
//   torso/head/legs use [x, y, z]: +x bends forward/down, y turns, z tilts; legs: -x swings forward, +x on the knee bends it.
//   arm-chain bones (shoulder/arm/hand/fingers) use [forward, raise, twist], i.e. rotations about [y, z, x],
//   because arms point sideways: left arm forward = -, raise = +; right arm forward = +, raise = -.
//   So [-8, -72, 0] on the left upper arm means "slightly forward, lowered 72 degrees".

type Euler = [number, number, number]
type Pose = Partial<Record<VRMHumanBoneName, Euler>> & { hipsPos?: Euler }
export interface ClipSpec { duration: number; loop: boolean; keys: [number, Pose][] }

const D = THREE.MathUtils.DEG2RAD

// A relaxed standing base that most clips start from.
const ARMS_DOWN: Pose = {
  leftUpperArm: [-8, -72, 0], rightUpperArm: [8, 72, 0],
  leftLowerArm: [-12, 0, 0], rightLowerArm: [12, 0, 0],
  leftHand: [0, -6, 0], rightHand: [0, 6, 0]
}
const FINGERS_SOFT: Pose = Object.fromEntries(
  (['Index', 'Middle', 'Ring', 'Little'] as const).flatMap((f) => [
    [`left${f}Proximal`, [0, -18, 0]], [`left${f}Intermediate`, [0, -22, 0]],
    [`right${f}Proximal`, [0, 18, 0]], [`right${f}Intermediate`, [0, 22, 0]]
  ])
)
const base = (p: Pose): Pose => ({ ...FINGERS_SOFT, ...ARMS_DOWN, ...p })

export const PROCEDURAL: Record<string, ClipSpec> = {
  idle: {
    duration: 4, loop: true, keys: [
      [0, base({ hipsPos: [0, 0, 0], spine: [2, 0, 0], head: [2, 0, 2] })],
      [2, base({ hipsPos: [0.012, -0.004, 0], spine: [2, 0, -1.5], head: [1, 3, -3], leftUpperArm: [-6, -70, 0], rightUpperArm: [10, 73, 0] })],
      [4, base({ hipsPos: [0, 0, 0], spine: [2, 0, 0], head: [2, 0, 2] })]
    ]
  },
  idleHappy: {
    duration: 1.2, loop: true, keys: [
      [0, base({ hipsPos: [0, 0, 0], head: [0, 0, 6], spine: [0, 0, 2] })],
      [0.3, base({ hipsPos: [0, -0.02, 0], head: [4, 0, 8], leftLowerArm: [-30, 0, 0], rightLowerArm: [30, 0, 0] })],
      [0.6, base({ hipsPos: [0, 0, 0], head: [0, 0, -6], spine: [0, 0, -2] })],
      [0.9, base({ hipsPos: [0, -0.02, 0], head: [4, 0, -8], leftLowerArm: [-30, 0, 0], rightLowerArm: [30, 0, 0] })],
      [1.2, base({ hipsPos: [0, 0, 0], head: [0, 0, 6], spine: [0, 0, 2] })]
    ]
  },
  walk: walkCycle(0.9, 21, 0.018),
  run: walkCycle(0.55, 34, 0.035, 10),
  wave: {
    duration: 1.8, loop: false, keys: [
      [0, base({})],
      [0.25, base({ rightUpperArm: [30, -40, 0], rightLowerArm: [0, -80, 0], head: [0, -5, -8] })],
      [0.5, base({ rightUpperArm: [30, -40, 0], rightLowerArm: [0, -60, 0], rightHand: [0, -10, 0], head: [0, -5, -8] })],
      [0.75, base({ rightUpperArm: [30, -40, 0], rightLowerArm: [0, -95, 0], rightHand: [0, 10, 0], head: [0, -5, -8] })],
      [1.0, base({ rightUpperArm: [30, -40, 0], rightLowerArm: [0, -60, 0], rightHand: [0, -10, 0], head: [0, -5, -8] })],
      [1.25, base({ rightUpperArm: [30, -40, 0], rightLowerArm: [0, -95, 0], rightHand: [0, 10, 0], head: [0, -5, -8] })],
      [1.8, base({})]
    ]
  },
  nod: {
    duration: 0.9, loop: false, keys: [
      [0, base({ head: [0, 0, 0] })], [0.2, base({ head: [16, 0, 0], neck: [6, 0, 0] })],
      [0.4, base({ head: [-2, 0, 0] })], [0.6, base({ head: [12, 0, 0], neck: [4, 0, 0] })], [0.9, base({})]
    ]
  },
  shake: {
    duration: 1.0, loop: false, keys: [
      [0, base({})], [0.2, base({ head: [3, 18, 0] })], [0.4, base({ head: [3, -18, 0] })],
      [0.6, base({ head: [3, 14, 0] })], [0.8, base({ head: [3, -10, 0] })], [1.0, base({})]
    ]
  },
  think: {
    duration: 3, loop: true, keys: [
      [0, base({ rightUpperArm: [50, 45, 0], rightLowerArm: [125, 0, 0], rightHand: [0, -25, 0], leftUpperArm: [-45, -62, 0], leftLowerArm: [-95, 0, 0], head: [-2, -8, 10] })],
      [1.5, base({ rightUpperArm: [50, 45, 0], rightLowerArm: [128, 0, 0], rightHand: [0, -25, 0], leftUpperArm: [-45, -62, 0], leftLowerArm: [-95, 0, 0], head: [-4, -12, 14] })],
      [3, base({ rightUpperArm: [50, 45, 0], rightLowerArm: [125, 0, 0], rightHand: [0, -25, 0], leftUpperArm: [-45, -62, 0], leftLowerArm: [-95, 0, 0], head: [-2, -8, 10] })]
    ]
  },
  talk: {
    duration: 2.4, loop: true, keys: [
      [0, base({ leftLowerArm: [-40, 0, 0], rightLowerArm: [40, 0, 0], head: [0, 0, 3] })],
      [0.6, base({ leftUpperArm: [-20, -65, 0], leftLowerArm: [-55, 0, 0], rightLowerArm: [35, 0, 0], head: [2, 4, -2] })],
      [1.2, base({ leftLowerArm: [-35, 0, 0], rightUpperArm: [20, 65, 0], rightLowerArm: [55, 0, 0], head: [0, -3, 4] })],
      [1.8, base({ leftLowerArm: [-45, 0, 0], rightLowerArm: [40, 0, 0], head: [3, 2, 0] })],
      [2.4, base({ leftLowerArm: [-40, 0, 0], rightLowerArm: [40, 0, 0], head: [0, 0, 3] })]
    ]
  },
  listen: {
    duration: 3, loop: true, keys: [
      [0, base({ spine: [6, 0, 0], head: [4, 0, 12], rightUpperArm: [10, 30, 0], rightLowerArm: [0, -140, 0] })],
      [1.5, base({ spine: [8, 0, 0], head: [6, 4, 14], rightUpperArm: [10, 30, 0], rightLowerArm: [0, -142, 0] })],
      [3, base({ spine: [6, 0, 0], head: [4, 0, 12], rightUpperArm: [10, 30, 0], rightLowerArm: [0, -140, 0] })]
    ]
  },
  jump: {
    duration: 0.8, loop: false, keys: [
      [0, base({ hipsPos: [0, 0, 0] })],
      [0.18, base({ hipsPos: [0, -0.12, 0], spine: [14, 0, 0], leftUpperLeg: [-40, 0, 0], rightUpperLeg: [-40, 0, 0], leftLowerLeg: [70, 0, 0], rightLowerLeg: [70, 0, 0], leftUpperArm: [30, -60, 0], rightUpperArm: [-30, 60, 0] })],
      [0.35, base({ hipsPos: [0, 0.03, 0], leftUpperArm: [0, -20, 0], rightUpperArm: [0, 20, 0], leftLowerLeg: [20, 0, 0], rightLowerLeg: [40, 0, 0] })],
      [0.8, base({ hipsPos: [0, 0, 0] })]
    ]
  },
  fall: {
    duration: 0.6, loop: true, keys: [
      [0, base({ leftUpperArm: [0, -10, 0], rightUpperArm: [0, 10, 0], leftLowerArm: [0, 20, 0], rightLowerArm: [0, -20, 0], leftUpperLeg: [-20, 0, 0], rightUpperLeg: [10, 0, 0], leftLowerLeg: [40, 0, 0], rightLowerLeg: [20, 0, 0], head: [-10, 0, 0] })],
      [0.3, base({ leftUpperArm: [0, 5, 0], rightUpperArm: [0, -5, 0], leftLowerArm: [0, 30, 0], rightLowerArm: [0, -30, 0], leftUpperLeg: [10, 0, 0], rightUpperLeg: [-20, 0, 0], leftLowerLeg: [20, 0, 0], rightLowerLeg: [40, 0, 0], head: [-10, 0, 0] })],
      [0.6, base({ leftUpperArm: [0, -10, 0], rightUpperArm: [0, 10, 0], leftLowerArm: [0, 20, 0], rightLowerArm: [0, -20, 0], leftUpperLeg: [-20, 0, 0], rightUpperLeg: [10, 0, 0], leftLowerLeg: [40, 0, 0], rightLowerLeg: [20, 0, 0], head: [-10, 0, 0] })]
    ]
  },
  dangle: {
    duration: 1.6, loop: true, keys: [
      [0, base({ leftUpperArm: [-5, -40, 0], rightUpperArm: [5, 40, 0], leftUpperLeg: [-6, 0, 3], rightUpperLeg: [4, 0, -3], leftLowerLeg: [15, 0, 0], rightLowerLeg: [25, 0, 0], head: [8, 0, 6] })],
      [0.8, base({ leftUpperArm: [-5, -48, 0], rightUpperArm: [5, 48, 0], leftUpperLeg: [6, 0, 3], rightUpperLeg: [-6, 0, -3], leftLowerLeg: [30, 0, 0], rightLowerLeg: [12, 0, 0], head: [8, 0, -6] })],
      [1.6, base({ leftUpperArm: [-5, -40, 0], rightUpperArm: [5, 40, 0], leftUpperLeg: [-6, 0, 3], rightUpperLeg: [4, 0, -3], leftLowerLeg: [15, 0, 0], rightLowerLeg: [25, 0, 0], head: [8, 0, 6] })]
    ]
  },
  land: {
    duration: 0.5, loop: false, keys: [
      [0, base({ hipsPos: [0, -0.1, 0], spine: [12, 0, 0], leftUpperLeg: [-35, 0, 0], rightUpperLeg: [-35, 0, 0], leftLowerLeg: [60, 0, 0], rightLowerLeg: [60, 0, 0], leftFoot: [-25, 0, 0], rightFoot: [-25, 0, 0] })],
      [0.5, base({ hipsPos: [0, 0, 0] })]
    ]
  },
  sit: {
    duration: 3, loop: true, keys: [
      [0, base(sitPose(0))], [1.5, base(sitPose(1))], [3, base(sitPose(0))]
    ]
  },
  sitFloor: {
    duration: 3, loop: true, keys: [
      [0, base(floorSitPose(0))], [1.5, base(floorSitPose(1))], [3, base(floorSitPose(0))]
    ]
  },
  sleepFloor: {
    duration: 4, loop: true, keys: [
      [0, base({ ...floorSitPose(0), head: [28, 0, 14], neck: [10, 0, 0], spine: [12, 0, 0] })],
      [2, base({ ...floorSitPose(0), head: [32, 0, 16], neck: [12, 0, 0], spine: [14, 0, 0] })],
      [4, base({ ...floorSitPose(0), head: [28, 0, 14], neck: [10, 0, 0], spine: [12, 0, 0] })]
    ]
  },
  sleep: {
    duration: 4, loop: true, keys: [
      [0, base({ ...sitPose(0), head: [28, 0, 14], neck: [10, 0, 0], spine: [10, 0, 0] })],
      [2, base({ ...sitPose(0), head: [32, 0, 16], neck: [12, 0, 0], spine: [12, 0, 0] })],
      [4, base({ ...sitPose(0), head: [28, 0, 14], neck: [10, 0, 0], spine: [10, 0, 0] })]
    ]
  },
  cheer: {
    duration: 1.2, loop: false, keys: [
      [0, base({})],
      [0.2, base({ hipsPos: [0, -0.04, 0], leftUpperArm: [0, 40, 0], rightUpperArm: [0, -40, 0], leftLowerArm: [0, 30, 0], rightLowerArm: [0, -30, 0], head: [-8, 0, 0] })],
      [0.45, base({ hipsPos: [0, 0.04, 0], leftUpperArm: [0, 65, 0], rightUpperArm: [0, -65, 0], leftLowerArm: [0, 10, 0], rightLowerArm: [0, -10, 0], head: [-12, 0, 0] })],
      [0.7, base({ hipsPos: [0, -0.02, 0], leftUpperArm: [0, 45, 0], rightUpperArm: [0, -45, 0], leftLowerArm: [0, 35, 0], rightLowerArm: [0, -35, 0], head: [-6, 0, 0] })],
      [0.95, base({ hipsPos: [0, 0.03, 0], leftUpperArm: [0, 65, 0], rightUpperArm: [0, -65, 0], head: [-10, 0, 0] })],
      [1.2, base({})]
    ]
  },
  shy: {
    duration: 2.4, loop: true, keys: [
      [0, base(shyPose(0))], [1.2, base(shyPose(1))], [2.4, base(shyPose(0))]
    ]
  },
  clap: {
    duration: 1.2, loop: false, keys: [
      [0, base({})],
      ...[0.2, 0.45, 0.7, 0.95].map((t, i): [number, Pose] => [t, base(clapPose(i % 2 === 0))]),
      [1.2, base({})]
    ]
  },
  stretch: {
    duration: 3, loop: false, keys: [
      [0, base({})],
      [0.8, base({ leftUpperArm: [0, 75, 0], rightUpperArm: [0, -75, 0], leftLowerArm: [0, 15, 0], rightLowerArm: [0, -15, 0], spine: [-10, 0, 0], head: [-15, 0, 0] })],
      [1.8, base({ leftUpperArm: [0, 80, 0], rightUpperArm: [0, -80, 0], leftLowerArm: [0, 10, 0], rightLowerArm: [0, -10, 0], spine: [-6, 0, 10], head: [-12, 0, 8] })],
      [3, base({})]
    ]
  },
  dance: {
    duration: 2, loop: true, keys: [
      [0, base({ hipsPos: [0.03, 0, 0], spine: [0, 0, -6], head: [0, 0, 10], leftUpperArm: [0, -30, 0], rightUpperArm: [0, 70, 0], leftLowerArm: [-60, 0, 0], leftUpperLeg: [0, 0, 4] })],
      [0.5, base({ hipsPos: [0, -0.03, 0], spine: [0, 0, 0], head: [0, 0, 0], leftUpperArm: [-20, -60, 0], rightUpperArm: [20, 60, 0], leftLowerLeg: [20, 0, 0], rightLowerLeg: [20, 0, 0] })],
      [1, base({ hipsPos: [-0.03, 0, 0], spine: [0, 0, 6], head: [0, 0, -10], rightUpperArm: [0, 30, 0], leftUpperArm: [0, -70, 0], rightLowerArm: [60, 0, 0], rightUpperLeg: [0, 0, -4] })],
      [1.5, base({ hipsPos: [0, -0.03, 0], spine: [0, 0, 0], head: [0, 0, 0], leftUpperArm: [-20, -60, 0], rightUpperArm: [20, 60, 0], leftLowerLeg: [20, 0, 0], rightLowerLeg: [20, 0, 0] })],
      [2, base({ hipsPos: [0.03, 0, 0], spine: [0, 0, -6], head: [0, 0, 10], leftUpperArm: [0, -30, 0], rightUpperArm: [0, 70, 0], leftLowerArm: [-60, 0, 0], leftUpperLeg: [0, 0, 4] })]
    ]
  },
  pout: {
    duration: 2, loop: true, keys: [
      [0, base({ leftUpperArm: [-50, -55, 0], rightUpperArm: [50, 55, 0], leftLowerArm: [-110, 0, 0], rightLowerArm: [110, 0, 0], head: [-6, 25, 0] })],
      [1, base({ leftUpperArm: [-50, -55, 0], rightUpperArm: [50, 55, 0], leftLowerArm: [-112, 0, 0], rightLowerArm: [112, 0, 0], head: [-8, 28, 3] })],
      [2, base({ leftUpperArm: [-50, -55, 0], rightUpperArm: [50, 55, 0], leftLowerArm: [-110, 0, 0], rightLowerArm: [110, 0, 0], head: [-6, 25, 0] })]
    ]
  },
  headpat: {
    duration: 2, loop: false, keys: [
      [0, base({})], [0.3, base({ head: [10, 0, 10], neck: [6, 0, 0], spine: [4, 0, 0] })],
      [1.0, base({ head: [12, 0, -8], neck: [6, 0, 0], spine: [4, 0, 0] })], [1.6, base({ head: [10, 0, 10], neck: [6, 0, 0] })], [2, base({})]
    ]
  }
}

function walkCycle(period: number, swing: number, bob: number, lean = 4): ClipSpec {
  const step = (phase: number): Pose => {
    const s = Math.sin(phase * Math.PI * 2)
    const c = Math.cos(phase * Math.PI * 2)
    return base({
      hipsPos: [0, -bob * Math.abs(c), 0],
      hips: [0, s * 6, 0],
      spine: [lean, -s * 4, 0],
      head: [-lean / 2, s * 2, 0],
      leftUpperLeg: [-s * swing, 0, 0], rightUpperLeg: [s * swing, 0, 0],
      leftLowerLeg: [Math.max(0, s) * swing * 1.4 + 6, 0, 0], rightLowerLeg: [Math.max(0, -s) * swing * 1.4 + 6, 0, 0],
      leftUpperArm: [-8, -72, 0].map((v, i) => (i === 0 ? v + s * swing * 0.7 : v)) as Euler,
      rightUpperArm: [8, 72, 0].map((v, i) => (i === 0 ? v + s * swing * 0.7 : v)) as Euler,
      leftLowerArm: [-20, 0, 0], rightLowerArm: [20, 0, 0]
    })
  }
  const keys: [number, Pose][] = []
  for (let i = 0; i <= 8; i++) keys.push([(period * i) / 8, step(i / 8)])
  return { duration: period, loop: true, keys }
}

function sitPose(t: number): Pose {
  const swing = t ? 10 : -6
  return {
    leftUpperLeg: [-85, 0, 4], rightUpperLeg: [-85, 0, -4],
    leftLowerLeg: [80 + swing, 0, 0], rightLowerLeg: [80 - swing, 0, 0],
    spine: [-4, 0, 0], head: [6, t ? 6 : -4, t ? 6 : 2],
    leftUpperArm: [-20, -78, 0], rightUpperArm: [20, 78, 0], leftLowerArm: [-10, 0, 0], rightLowerArm: [10, 0, 0]
  }
}

// Sitting on the ground (the taskbar): legs stretched forward toward the viewer, hands on the floor beside her.
function floorSitPose(t: number): Pose {
  return {
    leftUpperLeg: [-88, 0, 6], rightUpperLeg: [-88, 0, -6],
    leftLowerLeg: [t ? 12 : 4, 0, 0], rightLowerLeg: [t ? 4 : 12, 0, 0],
    leftFoot: [-10, 0, 0], rightFoot: [-10, 0, 0],
    spine: [-6, 0, 0], head: [4, t ? 6 : -4, t ? 7 : 3],
    leftUpperArm: [-25, -70, 0], rightUpperArm: [25, 70, 0], leftLowerArm: [-5, 0, 0], rightLowerArm: [5, 0, 0]
  }
}

function shyPose(t: number): Pose {
  return {
    leftUpperArm: [-40, -65, 0], rightUpperArm: [40, 65, 0],
    leftLowerArm: [-75, 0, 0], rightLowerArm: [75, 0, 0],
    head: [14, t ? -12 : -8, t ? -10 : -6], spine: [4, 0, t ? 3 : 1],
    leftUpperLeg: [0, 0, -3], rightUpperLeg: [0, 0, 3], hipsPos: [t ? 0.01 : -0.01, 0, 0]
  }
}

function clapPose(open: boolean): Pose {
  const o = open ? 12 : 0
  return {
    leftUpperArm: [-50 + o, -55, 0], rightUpperArm: [50 - o, 55, 0],
    leftLowerArm: [-80, 0, 0], rightLowerArm: [80, 0, 0], head: [-4, 0, 0]
  }
}

/** Builds a THREE clip that targets the VRM's normalized bones. */
export function buildClip(name: string, spec: ClipSpec, vrm: VRM): THREE.AnimationClip {
  const bones = new Set<string>()
  for (const [, pose] of spec.keys) for (const b of Object.keys(pose)) bones.add(b)
  const tracks: THREE.KeyframeTrack[] = []
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const times = spec.keys.map(([t]) => t)

  for (const bone of bones) {
    if (bone === 'hipsPos') {
      const hips = vrm.humanoid.getNormalizedBoneNode('hips')
      if (!hips) continue
      const rest = hips.position.clone()
      const values = spec.keys.flatMap(([, p]) => {
        const d = p.hipsPos ?? [0, 0, 0]
        return [rest.x + d[0], rest.y + d[1], rest.z + d[2]]
      })
      tracks.push(new THREE.VectorKeyframeTrack(`${hips.name}.position`, times, values))
      continue
    }
    const node = vrm.humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName)
    if (!node) continue
    const isArmChain = /Shoulder|Arm|Hand|Thumb|Index|Middle|Ring|Little/.test(bone)
    const values = spec.keys.flatMap(([, p]) => {
      const r = (p as Record<string, Euler | undefined>)[bone] ?? [0, 0, 0]
      if (isArmChain) e.set(r[2] * D, r[0] * D, r[1] * D, 'YZX')
      else e.set(r[0] * D, r[1] * D, r[2] * D, 'YZX')
      return q.setFromEuler(e).toArray()
    })
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values))
  }
  return new THREE.AnimationClip(name, spec.duration, tracks)
}
