import type { VRM } from '@pixiv/three-vrm'

// Her model only has five emotion presets (happy, angry, sad, relaxed, surprised), the five mouth shapes
// and left/right blinks. Every emotion below is a recipe built from those, plus body language that
// the behaviour layer reads from `pose`: head tilt, lean, and where her eyes drift (looking away when
// shy, down when lonely). Some faces also move on their own: lips tremble, she sniffles, or she winks.

export const EMOTIONS = [
  'neutral', 'happy', 'excited', 'proud', 'love', 'grateful', 'playful', 'smug', 'relaxed', 'curious',
  'determined', 'surprised', 'confused', 'shy', 'embarrassed', 'nervous', 'worried', 'scared', 'sad',
  'lonely', 'disappointed', 'hurt', 'cry', 'pout', 'jealous', 'grumpy', 'angry', 'bored', 'sleepy'
] as const
export type Emotion = typeof EMOTIONS[number]

interface Face {
  /** Preset weights. Mouth shapes (aa ih ou ee oh) here are her resting mouth while she's quiet. */
  w: Record<string, number>
  blush?: number
  /** Both eyelids partly closed (sleepy, soft, squinting). */
  eyes?: number
  /** A quick wink when the emotion starts. */
  wink?: 'left' | 'right'
  /** Lips and brows quiver (crying, nervous, scared). */
  tremble?: number
  /** Teary: every few seconds she squeezes her eyes and sniffles. */
  sniffle?: boolean
  /** Where her eyes drift, as a fraction of her height (x: right, y: down). She peeks back now and then. */
  glance?: [number, number]
  /** Head tilt and lean in degrees. */
  tilt?: number
  lean?: number
  /** How fast the face changes: surprise snaps on, sadness creeps in. Default 10. */
  speed?: number
  /** Emote that fits a strong version of this emotion. */
  emote?: string
  /** Idle loop that suits the mood. */
  idle?: 'idle' | 'idleHappy' | 'shy' | 'pout'
}

const FACES: Record<Emotion, Face> = {
  neutral: { w: {} },
  happy: { w: { happy: 0.85 }, idle: 'idleHappy', emote: 'sparkle' },
  excited: { w: { happy: 0.75, surprised: 0.3, aa: 0.15 }, blush: 0.3, lean: 2, speed: 16, idle: 'idleHappy', emote: 'sparkle' },
  proud: { w: { happy: 0.6, relaxed: 0.3 }, eyes: 0.15, tilt: -3, lean: -3, idle: 'idleHappy', emote: 'star' },
  love: { w: { happy: 0.8, relaxed: 0.3 }, eyes: 0.2, blush: 0.9, tilt: 8, speed: 6, idle: 'shy', emote: 'heart' },
  grateful: { w: { happy: 0.65, relaxed: 0.35 }, eyes: 0.3, blush: 0.4, tilt: 5, speed: 6, idle: 'idleHappy', emote: 'heart' },
  playful: { w: { happy: 0.7, ee: 0.1 }, wink: 'right', tilt: 7, idle: 'idleHappy', emote: 'music' },
  smug: { w: { relaxed: 0.5, happy: 0.35 }, eyes: 0.2, tilt: -4, lean: -2, emote: 'sparkle' },
  relaxed: { w: { relaxed: 0.8 }, eyes: 0.15, speed: 5 },
  curious: { w: { surprised: 0.35, happy: 0.2 }, tilt: 9, lean: 5, emote: 'question' },
  determined: { w: { angry: 0.3, happy: 0.35 }, eyes: 0.1, lean: 3, emote: 'fire' },
  surprised: { w: { surprised: 0.85, oh: 0.2 }, lean: -3, speed: 20, emote: 'sparkle' },
  confused: { w: { surprised: 0.3, sad: 0.15, ih: 0.1 }, tilt: -11, emote: 'question' },
  shy: { w: { happy: 0.4, relaxed: 0.45 }, blush: 1, glance: [-0.35, 0.2], tilt: 6, speed: 7, idle: 'shy', emote: 'heart' },
  embarrassed: { w: { happy: 0.25, sad: 0.25, surprised: 0.15, ih: 0.15 }, blush: 1, glance: [-0.5, 0.3], tilt: 6, tremble: 0.15, idle: 'shy', emote: 'sweat' },
  nervous: { w: { surprised: 0.25, sad: 0.3, happy: 0.15, ih: 0.2 }, tremble: 0.45, glance: [0.25, 0.05], emote: 'sweat' },
  worried: { w: { sad: 0.45, surprised: 0.2 }, tremble: 0.12, tilt: 4, emote: 'sweat' },
  scared: { w: { surprised: 0.7, sad: 0.35, oh: 0.2 }, tremble: 0.8, lean: -5, speed: 18, emote: 'sweat' },
  sad: { w: { sad: 0.8 }, glance: [0.15, 0.25], lean: 2, speed: 5 },
  lonely: { w: { sad: 0.6, relaxed: 0.2 }, eyes: 0.25, glance: [0.3, 0.35], lean: 3, speed: 4 },
  disappointed: { w: { sad: 0.5, angry: 0.15 }, eyes: 0.2, glance: [0, 0.3], speed: 6 },
  hurt: { w: { sad: 0.75, surprised: 0.2 }, blush: 0.3, tremble: 0.3, sniffle: true, glance: [0.3, 0.2], speed: 8, emote: 'tear' },
  cry: { w: { sad: 1, surprised: 0.15 }, blush: 0.6, eyes: 0.35, tremble: 0.6, sniffle: true, glance: [0.1, 0.25], speed: 6, emote: 'tear' },
  pout: { w: { angry: 0.45, ou: 0.35 }, blush: 0.4, glance: [0.45, 0], tilt: -4, idle: 'pout', emote: 'anger' },
  jealous: { w: { angry: 0.35, sad: 0.2, ou: 0.25 }, blush: 0.3, eyes: 0.2, glance: [0.5, 0], idle: 'pout', emote: 'anger' },
  grumpy: { w: { angry: 0.55, relaxed: 0.2, ee: 0.1 }, eyes: 0.3, glance: [0.35, 0.05], idle: 'pout', emote: 'anger' },
  angry: { w: { angry: 0.8 }, lean: 2, speed: 14, idle: 'pout', emote: 'anger' },
  bored: { w: { relaxed: 0.5, sad: 0.1 }, eyes: 0.45, glance: [0.6, -0.2], tilt: -7, speed: 4 },
  sleepy: { w: { relaxed: 0.6 }, eyes: 0.55, tilt: 8, speed: 4, emote: 'sleep' }
}

/** Idle loop and default emote for an emotion (used by the behaviour layer). */
export const faceInfo = (e: Emotion) => ({ idle: FACES[e]?.idle ?? 'idle', emote: FACES[e]?.emote ?? null })

const DRIVEN = ['happy', 'angry', 'sad', 'relaxed', 'surprised']
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const

/** Smoothly blends emotions, blinks on its own, and mixes in lip-sync mouth shapes. */
export class Expressions {
  emotion: Emotion = 'neutral'
  /** 0.2..1: how strongly the current emotion shows. */
  intensity = 1
  /** What a held emotion settles back to (normally neutral; pout/cry while she's sulking). */
  base: Emotion = 'neutral'
  blush = 0
  /** Body language for the current emotion, read by the behaviour layer each frame. */
  readonly pose = { tilt: 0, lean: 0, glanceX: 0, glanceY: 0 }
  private face: Face = FACES.neutral
  private target: Record<string, number> = {}
  private current: Record<string, number> = {}
  private targetBlush = 0
  private extraEyes = 0
  private holdUntil = 0
  private blinkT = 2 + Math.random() * 3
  private blinkPhase = -1
  private doubleBlink = false
  private t = 0
  private winkT = 0
  private sniffT = 0
  private sniffPhase = -1
  eyesClosed = false
  /** 0..1 mouth openness and a viseme index, written by the lip-sync each frame. */
  mouth = 0
  private viseme = 0
  private visemeTimer = 0
  private curVis: Record<string, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }

  constructor(private readonly vrm: VRM) {}

  /** Mid-blink, talking, or a face that moves by itself (trembling, sniffling, winking). */
  get animating() {
    return this.blinkPhase >= 0 || this.mouth > 0.02 || this.winkT > 0 || this.sniffPhase >= 0 || (this.face.tremble ?? 0) > 0
  }

  /** Show an emotion at some intensity. With holdMs it reverts to the base mood afterwards. */
  set(e: Emotion, holdMs = 0, intensity = 1) {
    const f = FACES[e] ?? FACES.neutral
    const k = Math.max(0.2, Math.min(1, intensity))
    this.emotion = e
    this.intensity = k
    this.face = f
    this.target = Object.fromEntries(Object.entries(f.w).map(([n, v]) => [n, v * k]))
    this.targetBlush = (f.blush ?? 0) * k
    this.extraEyes = (f.eyes ?? 0) * k
    this.pose.tilt = (f.tilt ?? 0) * k
    this.pose.lean = (f.lean ?? 0) * k
    this.pose.glanceX = (f.glance?.[0] ?? 0) * k
    this.pose.glanceY = (f.glance?.[1] ?? 0) * k
    this.winkT = f.wink ? 0.55 : 0
    this.sniffT = f.sniffle ? 1.5 : 0
    this.holdUntil = holdMs ? performance.now() + holdMs : 0
  }

  setBlush(v: number) { this.targetBlush = v }

  update(dt: number) {
    const em = this.vrm.expressionManager
    if (!em) return
    if (this.holdUntil && performance.now() > this.holdUntil) this.set(this.base)
    this.t += dt
    const f = this.face

    const k = 1 - Math.exp(-dt * (f.speed ?? 10))
    for (const name of DRIVEN) {
      const cur = this.current[name] ?? 0
      this.current[name] = cur + ((this.target[name] ?? 0) - cur) * k
    }
    this.blush += (this.targetBlush - this.blush) * (1 - Math.exp(-dt * 4))

    // Trembling: a fast, uneven quiver on the brows (sad) and lips (ih), stronger for scared than nervous.
    const tremble = (f.tremble ?? 0) * this.intensity
    const quiver = tremble ? tremble * (0.5 + 0.5 * Math.sin(this.t * 31) * Math.sin(this.t * 7.3)) : 0

    // Sniffling: every few seconds a quick squeeze of the eyes and a pucker of the lips.
    let sniff = 0
    if (f.sniffle) {
      this.sniffT -= dt
      if (this.sniffT <= 0 && this.sniffPhase < 0) { this.sniffPhase = 0; this.sniffT = 3 + Math.random() * 3 }
    }
    if (this.sniffPhase >= 0) {
      this.sniffPhase += dt / 0.35
      sniff = Math.sin(Math.min(1, this.sniffPhase) * Math.PI)
      if (this.sniffPhase >= 1) this.sniffPhase = -1
    }

    // Lip-sync: pick a new vowel every ~90ms while the mouth is open, ease weights toward it.
    this.visemeTimer -= dt
    if (this.visemeTimer <= 0) {
      this.visemeTimer = 0.07 + Math.random() * 0.06
      this.viseme = Math.random() < 0.45 ? 0 : 1 + Math.floor(Math.random() * 4)
    }
    const talking = this.mouth > 0.02
    // Smiling while talking would fight the mouth shapes; soften the mouth-heavy emotion weights.
    const mouthDamp = talking ? 0.55 : 1
    for (let i = 0; i < VISEMES.length; i++) {
      const v = VISEMES[i]
      const want = talking && i === this.viseme ? Math.min(1, this.mouth * 1.25) : 0
      this.curVis[v] += (want - this.curVis[v]) * (1 - Math.exp(-dt * 22))
    }

    // Blinking: random 2-6s interval, sometimes a double blink. Skipped if eyes are meant to be shut.
    let blink = 0
    if (this.eyesClosed) blink = 1
    else {
      this.blinkT -= dt
      if (this.blinkT <= 0 && this.blinkPhase < 0) {
        this.blinkPhase = 0
        this.doubleBlink = Math.random() < 0.2
      }
      if (this.blinkPhase >= 0) {
        this.blinkPhase += dt / 0.16
        blink = Math.sin(Math.min(1, this.blinkPhase) * Math.PI)
        if (this.blinkPhase >= 1) {
          if (this.doubleBlink) { this.doubleBlink = false; this.blinkPhase = 0 }
          else { this.blinkPhase = -1; this.blinkT = 2 + Math.random() * 4 }
        }
      }
    }
    // Happy eyes are often already "closed" arcs on VRM faces; reduce blink amplitude so they don't over-close.
    const happyish = this.current.happy ?? 0
    blink = Math.max(blink * (1 - happyish * 0.6), this.extraEyes, sniff * 0.8)

    // Wink: one eye closes for half a second at the start of a playful face.
    let winkL = 0
    let winkR = 0
    if (this.winkT > 0) {
      this.winkT -= dt
      const w = Math.sin(Math.max(0, Math.min(1, 1 - this.winkT / 0.55)) * Math.PI)
      if (f.wink === 'left') winkL = w
      else winkR = w
    }

    for (const name of DRIVEN) {
      let v = (this.current[name] ?? 0) * (name === 'happy' ? mouthDamp : 1)
      if (name === 'sad') v += quiver * 0.2
      em.setValue(name, Math.min(1, v))
    }
    for (const v of VISEMES) {
      const rest = talking ? 0 : (this.target[v] ?? 0)
      const extra = !talking && v === 'ih' ? quiver * 0.3 : !talking && v === 'ou' ? sniff * 0.3 : 0
      em.setValue(v, Math.min(1, this.curVis[v] + rest + extra))
    }
    em.setValue('blink', Math.min(1, blink))
    em.setValue('blinkLeft', winkL)
    em.setValue('blinkRight', winkR)
  }
}
