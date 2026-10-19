import type { UserFeeling } from '../../shared/empathy'

// How she reacts to your feelings is learned, not hard-coded: a small contextual bandit.
//
// - Context: how you seem (one of 13 feelings, with confidence), whether it's late, and her character.
// - Choices: a handful of reactions (cheer you on, be gentle, tease, stay calm…).
// - Each choice's score = a starting instinct + learned weights · context. She picks with softmax, so she
//   mostly does what has worked and sometimes tries something else.
// - Reward comes from you within a couple of minutes: headpats, thanks and warm replies count for it;
//   "stop", annoyed pokes or muting her count against it. Weights move a little each time (REINFORCE
//   with a running baseline), so a few clear signals change her and one odd moment doesn't.
//
// Pure and seeded (tested); the state is saved with her encrypted memory.

export const REACTIONS = ['cheer', 'celebrate', 'comfort', 'reassure', 'calm', 'tease', 'curious', 'thank', 'match'] as const
export type Reaction = typeof REACTIONS[number]

/** What each reaction looks like on her. */
export const REACTION_FACE: Record<Reaction, { emotion: string; emote: string | null }> = {
  cheer: { emotion: 'excited', emote: 'sparkle' },
  celebrate: { emotion: 'proud', emote: 'star' },
  comfort: { emotion: 'worried', emote: 'heart' },
  reassure: { emotion: 'determined', emote: 'fire' },
  calm: { emotion: 'relaxed', emote: null },
  tease: { emotion: 'playful', emote: 'music' },
  curious: { emotion: 'curious', emote: 'question' },
  thank: { emotion: 'shy', emote: 'heart' },
  match: { emotion: 'happy', emote: null }
}

const FEELINGS: UserFeeling[] = ['happy', 'excited', 'proud', 'grateful', 'sad', 'lonely', 'stressed', 'anxious', 'angry', 'frustrated', 'tired', 'bored', 'neutral']
// Per feeling: [how sure we are, late night, playful character]. Nothing is shared across feelings, so
// learning "tease me when I'm happy" can't leak into how she treats you when you're sad.
const PER = 3
const DIM = FEELINGS.length * PER

/** Starting instincts (what a kind friend would do first). Learning moves away from these only with evidence. */
const PRIOR: Partial<Record<UserFeeling, Partial<Record<Reaction, number>>>> = {
  happy: { match: 1.2, cheer: 0.8, tease: 0.3 },
  excited: { cheer: 1.4, match: 0.6 },
  proud: { celebrate: 1.6, cheer: 0.8 },
  grateful: { thank: 1.6 },
  sad: { comfort: 1.6, calm: 0.4 },
  lonely: { comfort: 1.4, curious: 0.4 },
  stressed: { reassure: 1.2, calm: 1.0 },
  anxious: { reassure: 1.3, calm: 1.0 },
  angry: { calm: 1.5, comfort: 0.3 },
  frustrated: { reassure: 1.2, calm: 0.7 },
  tired: { calm: 1.2, comfort: 0.7 },
  bored: { tease: 1.0, curious: 1.0 },
  neutral: { match: 0.8, curious: 0.4 }
}

export interface LearnState {
  /** weights[reaction] = DIM numbers */
  w: Record<string, number[]>
  /** running average reward (baseline) */
  baseline: number
  /** lessons learned so far (rewards applied) */
  lessons: number
}

export const newLearn = (): LearnState => ({ w: Object.fromEntries(REACTIONS.map((r) => [r, new Array(DIM).fill(0)])), baseline: 0, lessons: 0 })

export function sanitizeLearn(x: unknown): LearnState {
  const s = newLearn()
  const o = x as Partial<LearnState> | null
  if (!o || typeof o !== 'object' || !o.w) return s
  for (const r of REACTIONS) {
    const row = o.w[r]
    if (Array.isArray(row) && row.length === DIM && row.every((v) => Number.isFinite(v))) s.w[r] = row.map((v) => Math.max(-4, Math.min(4, v)))
  }
  s.baseline = Number.isFinite(o.baseline) ? Math.max(-1, Math.min(1, o.baseline!)) : 0
  s.lessons = Number.isFinite(o.lessons) ? Math.max(0, Math.floor(o.lessons!)) : 0
  return s
}

export interface Context { feeling: UserFeeling; confidence: number; lateNight: boolean; playful: boolean }

export function features(c: Context): number[] {
  const x = new Array(DIM).fill(0)
  const at = Math.max(0, FEELINGS.indexOf(c.feeling)) * PER
  x[at] = Math.max(0.3, c.confidence)
  x[at + 1] = c.lateNight ? 1 : 0
  x[at + 2] = c.playful ? 1 : 0
  return x
}

function scores(s: LearnState, c: Context): number[] {
  const x = features(c)
  return REACTIONS.map((r) => {
    let v = PRIOR[c.feeling]?.[r] ?? 0
    // Her professional character doesn't tease unless you've taught her you like it.
    if (r === 'tease' && !c.playful) v -= 1
    for (let i = 0; i < DIM; i++) v += s.w[r][i] * x[i]
    return v
  })
}

export function probabilities(s: LearnState, c: Context, temperature = 0.6): Record<Reaction, number> {
  const sc = scores(s, c).map((v) => v / temperature)
  const m = Math.max(...sc)
  const e = sc.map((v) => Math.exp(v - m))
  const z = e.reduce((a, b) => a + b, 0)
  return Object.fromEntries(REACTIONS.map((r, i) => [r, e[i] / z])) as Record<Reaction, number>
}

/** Picks a reaction. `rand` in [0,1) is injected for tests. */
export function choose(s: LearnState, c: Context, rand = Math.random()): Reaction {
  const p = probabilities(s, c)
  let acc = 0
  for (const r of REACTIONS) { acc += p[r]; if (rand < acc) return r }
  return REACTIONS[REACTIONS.length - 1]
}

/** Learns from your response to a reaction she chose in context `c`. reward in [-1, 1]. */
export function learn(s: LearnState, c: Context, chosen: Reaction, reward: number, lr = 0.15): LearnState {
  const r = Math.max(-1, Math.min(1, reward))
  const x = features(c)
  const p = probabilities(s, c)
  const adv = r - s.baseline
  const w: Record<string, number[]> = {}
  for (const a of REACTIONS) {
    // Policy gradient for softmax: push the chosen reaction by (1 - p), the others down by p.
    const g = (a === chosen ? 1 - p[a] : -p[a]) * adv * lr
    w[a] = s.w[a].map((v, i) => Math.max(-4, Math.min(4, v + g * x[i])))
  }
  return { w, baseline: s.baseline + (r - s.baseline) * 0.1, lessons: s.lessons + 1 }
}

/** How the user responded, as a reward: kind words and pats up, "stop"/annoyance down. */
export function rewardFrom(signal: 'headpat' | 'praise' | 'thanks' | 'warm-reply' | 'reply' | 'annoyed' | 'stop' | 'poked-too-much' | 'muted' | 'dnd'): number {
  return { headpat: 0.9, praise: 0.8, thanks: 0.6, 'warm-reply': 0.5, reply: 0.15, annoyed: -0.8, stop: -1, 'poked-too-much': -0.5, muted: -0.6, dnd: -0.4 }[signal]
}

/** "stop that", "you're annoying", "shut up", "creepy", "bas karo"… */
export const ANNOYED = /\b(stop (it|that|doing that)|you'?re (so )?(annoying|creepy|weird|irritating)|annoying|shut up|chup|bas karo|mat karo|don'?t do that|leave me alone|not now|go away|cringe)\b/i
