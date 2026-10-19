import type { Emotion } from './expressions'

// Her inner state, as a continuous model rather than a list of moods:
//
// - PAD (pleasure, arousal, dominance), each -1..1. Things that happen push it ("appraisals"), and it
//   drifts back to her personality baseline: arousal settles in minutes, pleasure over half an hour.
// - Bond, 0..100: how close she feels to you. It grows a little each day you spend time together (capped
//   per day, so it means something), and fades slowly if you disappear for days. It is saved with memory.
// - Energy, 0..1: follows the time of day and drops during long sessions; low energy pulls her toward sleepy.
//
// The nearest emotion prototype to her PAD point becomes her resting face (subtle, never overriding a
// reaction), and a one-line description goes into the brain's instructions so her words match her face.
// Pure and clock-injected so it is unit-tested.

export interface AffectState {
  p: number
  a: number
  d: number
  bond: number
  energy: number
  updatedAt: number
  /** Bond gained today (daily cap) and the day it refers to. */
  bondToday: number
  bondDay: string
  /** Last day you two interacted, for the slow fade after long absences. */
  lastSeenDay: string
}

export type Appraisal =
  | 'talked' | 'praised' | 'thanked' | 'headpat' | 'poke' | 'poked-too-much' | 'dropped' | 'ignored'
  | 'apology' | 'goal-done' | 'focus-done' | 'focus-start' | 'distracted' | 'returned' | 'late-night'
  | 'user-happy' | 'user-excited' | 'user-proud' | 'user-sad' | 'user-stressed' | 'user-angry' | 'user-tired' | 'user-lonely'

/** Her resting point. Slightly positive and calm: she's a cheerful person. */
const BASE = { p: 0.2, a: 0.05, d: 0.05 }
/** Half-lives in minutes. */
const HALF = { p: 25, a: 4, d: 12 }
const BOND_CAP_PER_DAY = 3

const EFFECTS: Record<Appraisal, { p: number; a: number; d: number; bond: number }> = {
  talked: { p: 0.06, a: 0.08, d: 0.02, bond: 0.25 },
  praised: { p: 0.35, a: 0.25, d: 0.15, bond: 0.6 },
  thanked: { p: 0.25, a: 0.05, d: 0.05, bond: 0.4 },
  headpat: { p: 0.25, a: -0.05, d: -0.15, bond: 0.35 },
  poke: { p: 0.05, a: 0.25, d: 0, bond: 0.05 },
  'poked-too-much': { p: -0.25, a: 0.35, d: 0.25, bond: 0 },
  dropped: { p: -0.2, a: 0.45, d: -0.2, bond: 0 },
  ignored: { p: -0.3, a: -0.1, d: -0.2, bond: -0.4 },
  apology: { p: 0.3, a: -0.1, d: 0.1, bond: 0.3 },
  'goal-done': { p: 0.4, a: 0.35, d: 0.3, bond: 0.4 },
  'focus-done': { p: 0.45, a: 0.3, d: 0.3, bond: 0.8 },
  'focus-start': { p: 0.1, a: 0.25, d: 0.25, bond: 0.1 },
  distracted: { p: -0.12, a: 0.1, d: 0.1, bond: 0 },
  returned: { p: 0.3, a: 0.3, d: 0, bond: 0.2 },
  'late-night': { p: -0.05, a: -0.3, d: -0.05, bond: 0 },
  // Emotional contagion: she partly catches how you feel, but stays steadier than you.
  'user-happy': { p: 0.3, a: 0.2, d: 0.05, bond: 0.2 },
  'user-excited': { p: 0.3, a: 0.4, d: 0.1, bond: 0.2 },
  'user-proud': { p: 0.45, a: 0.35, d: 0.2, bond: 0.4 },
  'user-sad': { p: -0.25, a: -0.05, d: -0.15, bond: 0.3 },
  'user-stressed': { p: -0.15, a: 0.2, d: -0.1, bond: 0.2 },
  'user-angry': { p: -0.2, a: 0.3, d: -0.2, bond: 0 },
  'user-tired': { p: -0.05, a: -0.25, d: -0.05, bond: 0.1 },
  'user-lonely': { p: -0.2, a: -0.1, d: -0.1, bond: 0.4 }
}

/** Where each emotion sits in PAD space (after Mehrabian, tuned for her character). */
const PROTOTYPES: [Emotion, number, number, number][] = [
  ['neutral', 0, 0, 0], ['happy', 0.55, 0.3, 0.25], ['excited', 0.65, 0.75, 0.3], ['proud', 0.55, 0.3, 0.6],
  ['love', 0.75, 0.25, 0], ['grateful', 0.55, 0.05, -0.15], ['playful', 0.5, 0.5, 0.4], ['smug', 0.35, 0.1, 0.6],
  ['relaxed', 0.45, -0.4, 0.15], ['curious', 0.25, 0.4, 0.05], ['determined', 0.25, 0.5, 0.6],
  ['surprised', 0.1, 0.8, -0.1], ['confused', -0.1, 0.25, -0.35], ['shy', 0.3, 0.2, -0.5],
  ['embarrassed', -0.1, 0.4, -0.55], ['nervous', -0.3, 0.55, -0.5], ['worried', -0.4, 0.25, -0.3],
  ['scared', -0.6, 0.7, -0.6], ['sad', -0.6, -0.3, -0.4], ['lonely', -0.5, -0.4, -0.5],
  ['disappointed', -0.4, -0.2, -0.05], ['hurt', -0.6, 0.15, -0.5], ['pout', -0.3, 0.3, 0.25],
  ['jealous', -0.35, 0.4, 0], ['grumpy', -0.4, 0.05, 0.3], ['angry', -0.6, 0.7, 0.5], ['bored', -0.25, -0.6, 0],
  ['sleepy', 0.1, -0.8, -0.2]
]

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x))
const dayKeyOf = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function newAffect(now = Date.now()): AffectState {
  const day = dayKeyOf(now)
  return { ...BASE, bond: 5, energy: circadian(new Date(now).getHours()), updatedAt: now, bondToday: 0, bondDay: day, lastSeenDay: day }
}

/** 0..1: low in the small hours, peaks late morning and early evening. */
export function circadian(hour: number): number {
  const h = ((hour % 24) + 24) % 24
  const curve = [0.25, 0.18, 0.12, 0.1, 0.12, 0.2, 0.35, 0.55, 0.7, 0.8, 0.85, 0.85, 0.75, 0.68, 0.7, 0.75, 0.78, 0.8, 0.82, 0.78, 0.7, 0.6, 0.48, 0.35]
  return curve[h]
}

/** Let time pass: decay toward baseline, energy toward the time of day, slow bond fade after days apart. */
export function step(s: AffectState, now = Date.now()): AffectState {
  const mins = Math.max(0, (now - s.updatedAt) / 60000)
  if (mins <= 0) return s
  const toward = (x: number, base: number, half: number) => base + (x - base) * Math.pow(0.5, mins / half)
  const energyTarget = circadian(new Date(now).getHours())
  return {
    ...s,
    p: toward(s.p, BASE.p, HALF.p),
    a: toward(s.a, BASE.a, HALF.a),
    d: toward(s.d, BASE.d, HALF.d),
    energy: s.energy + (energyTarget - s.energy) * (1 - Math.pow(0.5, mins / 45)),
    updatedAt: now
  }
}

/** Whole days between two day keys (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const t = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)))
  return from && to ? Math.round((t(to) - t(from)) / 86400000) : 0
}

/** Something happened. `k` scales the effect (e.g. how sure we are they're sad). */
export function appraise(s0: AffectState, kind: Appraisal, k = 1, now = Date.now()): AffectState {
  const s = { ...step(s0, now) }
  const e = EFFECTS[kind]
  const day = dayKeyOf(now)
  // Back after days away: a few days are fine; beyond that the bond fades a little (once, on return).
  const apart = kind === 'ignored' ? 0 : daysBetween(s.lastSeenDay, day)
  if (apart > 3) s.bond = Math.max(0, s.bond - Math.min(apart - 3, 10) * 0.5)
  const bondToday = s.bondDay === day ? s.bondToday : 0
  // Gains are capped per day; losses are not (but are small).
  let dBond = e.bond * k
  if (dBond > 0) dBond = Math.max(0, Math.min(dBond, BOND_CAP_PER_DAY - bondToday))
  // Close friends forgive faster: negative pleasure hits softer as the bond grows.
  const soften = e.p < 0 ? 1 - Math.min(0.4, s.bond / 250) : 1
  const sat = (x: number, dx: number) => clamp(x + dx * (1 - Math.abs(x) * 0.5)) // diminishing returns near the edges
  return {
    ...s,
    p: sat(s.p, e.p * k * soften),
    a: sat(s.a, e.a * k),
    d: sat(s.d, e.d * k),
    bond: clamp(s.bond + dBond, 0, 100),
    bondToday: bondToday + Math.max(0, dBond),
    bondDay: day,
    lastSeenDay: kind === 'ignored' ? s.lastSeenDay : day
  }
}

/** Her resting emotion and how strongly it shows (0.2..1), from PAD and energy. */
export function restingEmotion(s: AffectState): { emotion: Emotion; intensity: number } {
  // Low energy drags arousal down (and at night she gets sleepy whatever else is going on).
  const a = clamp(s.a - Math.max(0, 0.55 - s.energy) * 1.6 + Math.max(0, s.energy - 0.55) * 0.4)
  let best: Emotion = 'neutral'
  let bestD = Infinity
  for (const [e, p, ar, d] of PROTOTYPES) {
    const dist = (s.p - p) ** 2 + (a - ar) ** 2 * 0.8 + (s.d - d) ** 2 * 0.5
    if (dist < bestD) { bestD = dist; best = e }
  }
  const strength = Math.sqrt(s.p ** 2 + a ** 2 + s.d ** 2) / Math.sqrt(3)
  // Near her calm centre the nearest prototype is noise: just a soft, content resting face.
  if (strength * 1.6 < 0.35) return { emotion: s.p >= 0.1 ? 'happy' : 'neutral', intensity: 0.2 }
  return { emotion: best, intensity: Math.max(0.2, Math.min(1, strength * 1.6)) }
}

export function bondLabel(bond: number): string {
  return bond < 12 ? 'just met' : bond < 30 ? 'getting to know each other' : bond < 55 ? 'good friends' : bond < 80 ? 'close friends' : 'best friends'
}

/** One line for the brain: how she feels right now and how close you two are. */
export function describe(s: AffectState): string {
  const mood = s.p > 0.45 ? 'really happy' : s.p > 0.15 ? 'cheerful' : s.p > -0.15 ? 'calm' : s.p > -0.45 ? 'a little down' : 'upset'
  const energy = s.energy < 0.25 ? 'very sleepy' : s.energy < 0.45 ? 'a bit tired' : s.a > 0.45 ? 'excited' : s.energy > 0.75 ? 'full of energy' : 'awake'
  return `${mood} and ${energy}; you two are ${bondLabel(s.bond)} (bond ${Math.round(s.bond)}/100)`
}

/** Keeps a loaded state valid (old saves, hand edits). */
export function sanitizeAffect(x: unknown, now = Date.now()): AffectState {
  const base = newAffect(now)
  if (!x || typeof x !== 'object') return base
  const o = x as Partial<AffectState>
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d)
  return {
    p: num(o.p, -1, 1, base.p), a: num(o.a, -1, 1, base.a), d: num(o.d, -1, 1, base.d),
    bond: num(o.bond, 0, 100, base.bond), energy: num(o.energy, 0, 1, base.energy),
    updatedAt: num(o.updatedAt, 0, now, now), bondToday: num(o.bondToday, 0, BOND_CAP_PER_DAY, 0),
    bondDay: typeof o.bondDay === 'string' ? o.bondDay : base.bondDay,
    lastSeenDay: typeof o.lastSeenDay === 'string' ? o.lastSeenDay : base.lastSeenDay
  }
}
