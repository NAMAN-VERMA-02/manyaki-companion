import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, type VRMAnimation } from '@pixiv/three-vrm-animation'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

// Slots the behaviour system asks for, and the file-name keywords that fill each slot.
// e.g. "Happy Idle.fbx" -> idleHappy, "Walking.fbx" -> walk. Order matters: first match wins.
export const SLOT_KEYWORDS: [string, RegExp][] = [
  ['idleHappy', /happy.?idle|idle.?happy/i],
  ['sitToStand', /sit.?to.?stand|stand.?up/i],
  ['sleep', /sleep|yawn/i],
  ['sit', /sit/i],
  ['idle', /idle|breath/i],
  ['run', /run/i],
  ['walk', /walk/i],
  ['jump', /jump/i],
  ['land', /land/i],
  ['dangle', /hang|dangl/i],
  ['fall', /fall/i],
  ['wave', /wav/i],
  ['nod', /nod|agree|yes/i],
  ['shake', /shak|no\b|disagree/i],
  ['think', /think|ponder/i],
  ['talk', /talk/i],
  ['cheer', /excit|cheer|victory|celebrat/i],
  ['shy', /bashful|shy/i],
  ['stretch', /stretch/i],
  ['clap', /clap/i],
  ['dance', /danc/i],
  ['pout', /angry|pout|annoy/i],
  ['listen', /listen/i]
]

export function slotForFile(url: string): string | null {
  const name = decodeURIComponent(url.split('/').pop() ?? '').replace(/\.(fbx|vrma)$/i, '')
  return SLOT_KEYWORDS.find(([, re]) => re.test(name))?.[0] ?? null
}

const MIXAMO_TO_VRM: Record<string, VRMHumanBoneName> = {
  mixamorigHips: 'hips', mixamorigSpine: 'spine', mixamorigSpine1: 'chest', mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck', mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder', mixamorigLeftArm: 'leftUpperArm', mixamorigLeftForeArm: 'leftLowerArm', mixamorigLeftHand: 'leftHand',
  mixamorigRightShoulder: 'rightShoulder', mixamorigRightArm: 'rightUpperArm', mixamorigRightForeArm: 'rightLowerArm', mixamorigRightHand: 'rightHand',
  mixamorigLeftUpLeg: 'leftUpperLeg', mixamorigLeftLeg: 'leftLowerLeg', mixamorigLeftFoot: 'leftFoot', mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg', mixamorigRightLeg: 'rightLowerLeg', mixamorigRightFoot: 'rightFoot', mixamorigRightToeBase: 'rightToes'
}
for (const side of ['Left', 'Right'] as const) {
  const s = side.toLowerCase() as 'left' | 'right'
  const fingers: [string, string][] = [['Thumb', 'Thumb'], ['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Pinky', 'Little']]
  for (const [mx, vr] of fingers) {
    const parts = vr === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']
    parts.forEach((p, i) => { MIXAMO_TO_VRM[`mixamorig${side}Hand${mx}${i + 1}`] = `${s}${vr}${p}` as VRMHumanBoneName })
  }
}

/**
 * Loads a Mixamo FBX ("Without Skin" is fine) and retargets it onto the VRM's normalized humanoid.
 * Based on the approach in three-vrm's official Mixamo example: convert each bone's rotation from the
 * Mixamo rest pose into the VRM's T-pose space, and scale hips motion to her leg length.
 * Horizontal root motion is removed so in-place and not-in-place clips both stay put; roaming moves her.
 */
export async function loadMixamoClip(url: string, vrm: VRM, name: string): Promise<THREE.AnimationClip> {
  const asset = await new FBXLoader().loadAsync(url)
  const source = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') ?? asset.animations[0]
  if (!source) throw new Error('no animation in ' + url)

  const tracks: THREE.KeyframeTrack[] = []
  const restRotationInverse = new THREE.Quaternion()
  const parentRestWorldRotation = new THREE.Quaternion()
  const q = new THREE.Quaternion()

  const mixamoHips = asset.getObjectByName('mixamorigHips')
  const motionHipsHeight = mixamoHips?.position.y || 100
  const vrmHipsHeight = Math.abs(vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? 0.9)
  const hipsScale = vrmHipsHeight / motionHipsHeight
  const isVRM0 = vrm.meta?.metaVersion === '0'

  for (const track of source.tracks) {
    const [rigName, prop] = track.name.split('.')
    const bone = MIXAMO_TO_VRM[rigName]
    const node = bone && vrm.humanoid.getNormalizedBoneNode(bone)
    const rigNode = asset.getObjectByName(rigName)
    if (!node || !rigNode || !rigNode.parent) continue

    rigNode.getWorldQuaternion(restRotationInverse).invert()
    rigNode.parent.getWorldQuaternion(parentRestWorldRotation)

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = new Float32Array(track.values.length)
      for (let i = 0; i < track.values.length; i += 4) {
        q.fromArray(track.values, i).premultiply(parentRestWorldRotation).multiply(restRotationInverse)
        q.toArray(values, i)
        if (isVRM0) { values[i] = -values[i]; values[i + 2] = -values[i + 2] }
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.${prop}`, track.times, values))
    } else if (track instanceof THREE.VectorKeyframeTrack && bone === 'hips' && prop === 'position') {
      const rest = node.position
      const values = new Float32Array(track.values.length)
      const x0 = track.values[0]
      const z0 = track.values[2]
      for (let i = 0; i < track.values.length; i += 3) {
        // Keep the subtle sway around the start position but drop travel across the floor.
        const dx = (track.values[i] - x0) * hipsScale
        const dz = (track.values[i + 2] - z0) * hipsScale
        values[i] = rest.x + THREE.MathUtils.clamp(dx, -0.05, 0.05) * (isVRM0 ? -1 : 1)
        values[i + 1] = track.values[i + 1] * hipsScale
        values[i + 2] = rest.z + THREE.MathUtils.clamp(dz, -0.05, 0.05) * (isVRM0 ? -1 : 1)
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.position`, track.times, values))
    }
  }
  return new THREE.AnimationClip(name, source.duration, tracks)
}

export async function loadVrmaClip(url: string, vrm: VRM, name: string): Promise<THREE.AnimationClip> {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
  const gltf = await loader.loadAsync(url)
  const anim = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0]
  if (!anim) throw new Error('no VRM animation in ' + url)
  const clip = createVRMAnimationClip(anim, vrm)
  clip.name = name
  // Expression/lookAt tracks from the file would fight our own face system; keep body motion only.
  clip.tracks = clip.tracks.filter((t) => /\.(quaternion|position)$/.test(t.name))
  return clip
}
