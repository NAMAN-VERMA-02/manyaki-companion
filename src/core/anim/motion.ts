import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { buildClip, PROCEDURAL } from './procedural'
import { loadMixamoClip, loadVrmaClip, slotForFile } from './clips'

const LOOPING = new Set(['idle', 'idleHappy', 'walk', 'run', 'fall', 'dangle', 'sit', 'sitFloor', 'sleep', 'sleepFloor', 'think', 'talk', 'listen', 'shy', 'dance', 'pout'])

export interface PlayOptions { fade?: number; speed?: number }

/** Owns the AnimationMixer and crossfades between named motions (procedural or user-supplied clips). */
export class Motion {
  readonly mixer: THREE.AnimationMixer
  private readonly actions = new Map<string, THREE.AnimationAction>()
  readonly source = new Map<string, 'procedural' | 'mocap'>()
  current = ''
  private currentAction: THREE.AnimationAction | null = null
  private oneShot: { resolve: () => void; action: THREE.AnimationAction } | null = null

  constructor(private readonly vrm: VRM) {
    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.mixer.addEventListener('finished', (e) => {
      if (this.oneShot && e.action === this.oneShot.action) {
        const r = this.oneShot.resolve
        this.oneShot = null
        r()
      }
    })
    for (const [name, spec] of Object.entries(PROCEDURAL)) this.add(name, buildClip(name, spec, vrm), 'procedural')
  }

  /** Loads every .fbx/.vrma the user dropped into the anims folders; each replaces the procedural slot it matches. */
  async loadUserClips(urls: string[], log: (m: string) => void): Promise<number> {
    let n = 0
    await Promise.all(urls.map(async (url) => {
      const slot = slotForFile(url)
      if (!slot) { log(`anim: no slot matches ${url}`); return }
      try {
        const clip = /\.vrma$/i.test(url) ? await loadVrmaClip(url, this.vrm, slot) : await loadMixamoClip(url, this.vrm, slot)
        this.add(slot, clip, 'mocap')
        n++
      } catch (err) {
        log(`anim: failed to load ${url}: ${(err as Error).message}`)
      }
    }))
    return n
  }

  private add(name: string, clip: THREE.AnimationClip, source: 'procedural' | 'mocap') {
    const old = this.actions.get(name)
    const action = this.mixer.clipAction(clip)
    action.setLoop(LOOPING.has(name) ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    action.clampWhenFinished = true
    this.actions.set(name, action)
    this.source.set(name, source)
    if (old && old === this.currentAction) {
      // Swap a running procedural clip for the freshly loaded mocap one.
      action.reset().play()
      old.crossFadeTo(action, 0.3, false)
      this.currentAction = action
    }
  }

  has(name: string) { return this.actions.has(name) }
  names() { return [...this.actions.keys()].sort() }
  isMocap(name: string) { return this.source.get(name) === 'mocap' }

  /** Switch to a looping (or held) motion. No-op if it is already playing. */
  play(name: string, opts: PlayOptions = {}) {
    const next = this.actions.get(name) ?? this.actions.get('idle')!
    if (this.oneShot) { const r = this.oneShot.resolve; this.oneShot = null; r() }
    next.timeScale = opts.speed ?? 1
    if (next === this.currentAction && next.isRunning()) return
    next.setLoop(LOOPING.has(name) ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    this.crossfade(next, opts.fade ?? 0.3, next === this.currentAction)
    this.current = name
  }

  /** Play a motion once, then resolve (the caller decides what comes next). */
  once(name: string, opts: PlayOptions = {}): Promise<void> {
    const next = this.actions.get(name)
    if (!next) return Promise.resolve()
    if (this.oneShot) { const r = this.oneShot.resolve; this.oneShot = null; r() }
    next.timeScale = opts.speed ?? 1
    next.setLoop(THREE.LoopOnce, 1)
    this.crossfade(next, opts.fade ?? 0.25, true)
    this.current = name
    return new Promise((resolve) => { this.oneShot = { resolve, action: next } })
  }

  private crossfade(next: THREE.AnimationAction, fade: number, restart = false) {
    const prev = this.currentAction
    if (restart || !next.isRunning()) next.reset()
    next.enabled = true
    next.setEffectiveWeight(1)
    next.play()
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false)
    this.currentAction = next
  }

  update(dt: number) {
    this.mixer.update(dt)
  }
}
