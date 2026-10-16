import type { VRM } from '@pixiv/three-vrm'

export type Emotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised' | 'relaxed' | 'shy' | 'pout' | 'sleepy' | 'excited' | 'smug' | 'worried'

// Combos layered from the model's preset expressions to get more personality than the six built-ins.
const RECIPES: Record<Emotion, { w: Record<string, number>; blush?: number; eyes?: number }> = {
  neutral: { w: {} },
  happy: { w: { happy: 0.85 } },
  excited: { w: { happy: 0.75, surprised: 0.3 }, blush: 0.3 },
  sad: { w: { sad: 0.8 } },
  worried: { w: { sad: 0.45, surprised: 0.2 } },
  angry: { w: { angry: 0.8 } },
  pout: { w: { angry: 0.45, ou: 0.35 }, blush: 0.4 },
  surprised: { w: { surprised: 0.85 } },
  relaxed: { w: { relaxed: 0.8 } },
  shy: { w: { happy: 0.4, relaxed: 0.45 }, blush: 1 },
  smug: { w: { relaxed: 0.5, happy: 0.35 } },
  sleepy: { w: { relaxed: 0.6 }, eyes: 0.55 }
}
const DRIVEN = ['happy', 'angry', 'sad', 'relaxed', 'surprised']
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const

/** Smoothly blends emotions, blinks on its own, and mixes in lip-sync mouth shapes. */
export class Expressions {
  emotion: Emotion = 'neutral'
  blush = 0
  private target: Record<string, number> = {}
  private current: Record<string, number> = {}
  private targetBlush = 0
  private extraEyes = 0
  private holdUntil = 0
  private blinkT = 2 + Math.random() * 3
  private blinkPhase = -1
  private doubleBlink = false
  eyesClosed = false
  /** 0..1 mouth openness and a viseme index, written by the lip-sync each frame. */
  mouth = 0
  private viseme = 0
  private visemeTimer = 0
  private curVis: Record<string, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }

  constructor(private readonly vrm: VRM) {}

  /** Mid-blink or mid-transition: worth rendering smoothly for a moment. */
  get animating() { return this.blinkPhase >= 0 || this.mouth > 0.02 }

  /** Show an emotion. With holdMs it reverts to `neutral` (or the base mood) afterwards. */
  set(e: Emotion, holdMs = 0) {
    this.emotion = e
    const r = RECIPES[e] ?? RECIPES.neutral
    this.target = { ...r.w }
    this.targetBlush = r.blush ?? 0
    this.extraEyes = r.eyes ?? 0
    this.holdUntil = holdMs ? performance.now() + holdMs : 0
  }

  setBlush(v: number) { this.targetBlush = v }

  update(dt: number) {
    const em = this.vrm.expressionManager
    if (!em) return
    if (this.holdUntil && performance.now() > this.holdUntil) this.set('neutral')

    const k = 1 - Math.exp(-dt * 10)
    for (const name of DRIVEN) {
      const cur = this.current[name] ?? 0
      const next = cur + ((this.target[name] ?? 0) - cur) * k
      this.current[name] = next
    }
    this.blush += (this.targetBlush - this.blush) * (1 - Math.exp(-dt * 4))

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
    const pout = this.target.ou ?? 0

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
    blink = Math.max(blink * (1 - happyish * 0.6), this.extraEyes)

    for (const name of DRIVEN) em.setValue(name, (this.current[name] ?? 0) * (name === 'happy' ? mouthDamp : 1))
    for (const v of VISEMES) em.setValue(v, Math.min(1, this.curVis[v] + (v === 'ou' && !talking ? pout : 0)))
    em.setValue('blink', Math.min(1, blink))
  }
}
