// Reading how the user feels, on this PC only. Pure functions (no DOM, no Electron) so they are unit-tested.
//
// - readText: a small English + Hindi/Hinglish + emoji lexicon with negation ("not happy") and intensifiers
//   ("bahut", "so", "!!!"). Cheap enough to run on every message, and it never leaves the PC.
// - readVoice: turns prosody features (see prosody.ts) into "sounds low-energy / excited / tense", judged
//   against the user's own baseline rather than a population average.
// - fuse: combines both into one feeling with a confidence, which drives her face, her mood and a short
//   hint for the brain. Only the label is ever used; raw audio features are not stored.

export type UserFeeling =
  | 'happy' | 'excited' | 'proud' | 'grateful' | 'sad' | 'lonely' | 'stressed' | 'anxious' | 'angry'
  | 'frustrated' | 'tired' | 'bored' | 'neutral'

export interface Empathy {
  feeling: UserFeeling
  /** 0..1 */
  confidence: number
  /** Short reasons, for the debug panel and tests. */
  cues: string[]
}

type Lexicon = Record<Exclude<UserFeeling, 'neutral'>, RegExp>

// Word stems, matched on word boundaries. Hinglish is written the way people type it in Roman script.
const LEX: Lexicon = {
  happy: /\b(happy|glad|good day|great day|nice|awesome|amazing|yay|yayy+|love (it|this)|feeling good|khush|maza aa ?gaya|mast|badhiya|accha laga|sahi hai|lit)\b/i,
  excited: /\b(excited|can'?t wait|hyped|let'?s go+|pumped|omg|woo+h?o+|so cool|finally|josh)\b/i,
  proud: /\b(i did it|nailed it|crushed it|cleared|passed|got (selected|placed|the (job|offer|internship))|aced|topped|won|ho gaya selection|selection ho gaya|pass ho gaya)\b/i,
  grateful: /\b(thanks?|thank you|thx|ty|grateful|appreciate|shukriya|dhanyavaad|thanku)\b/i,
  sad: /\b(sad|upset|down|depressed|cry(ing)?|crie?d|heartbroken|hurts?|miserable|unhappy|dukhi|udaas|rona|ro raha|ro rahi|bura lag|mood off|feeling low|not okay)\b/i,
  lonely: /\b(lonely|alone|no one|nobody (cares|talks)|akela|akeli|koi nahi hai)\b/i,
  stressed: /\b(stress(ed|ful)?|overwhelm(ed|ing)?|pressure|too much (work|to do)|deadline|burn(ed|t)? ?out|tension|so much work|kaam bahut|pagal ho)\b/i,
  anxious: /\b(anxious|nervous|scared|afraid|worried|panic(king)?|fear|darr?|ghabra|exam (kal|tomorrow)|what if i fail)\b/i,
  angry: /\b(angry|furious|mad at|hate|pissed|annoyed|irritat(ed|ing)|gussa|chid|wtf)\b/i,
  frustrated: /\b(frustrat(ed|ing)|stuck|not working|doesn'?t work|nothing works|fed up|give up|ugh+|argh+|kuch samajh nahi|chal nahi raha|error again|again error)\b/i,
  tired: /\b(tired|exhausted|sleepy|drained|no energy|so done|neend|thak (gaya|gayi|gya)|thaka|thaki)\b/i,
  bored: /\b(bored|boring|nothing to do|bore ho)\b/i
}

const EMOJI: Partial<Record<UserFeeling, RegExp>> = {
  happy: /[😀😃😄😁😊🙂☺😆🥳]/u,
  excited: /[🤩🔥🚀🎉]/u,
  sad: /[😢😭😞😔☹🙁💔🥺]/u,
  angry: /[😠😡🤬💢]/u,
  anxious: /[😰😨😟😬]/u,
  tired: /[😴🥱😪]/u,
  grateful: /[🙏]/u,
  frustrated: /[😤🤦]/u
}

const NEGATION = /\b(not|no|never|isn'?t|wasn'?t|don'?t|didn'?t|nahi|nahin|na|mat)\b/i
const INTENSIFIER = /\b(very|so|really|super|extremely|too|totally|bahut|bohot|bht|kaafi|ekdum|itna|itni)\b/i
// Feelings that a negation flips into (rough but useful: "not happy" reads as sad, "not tired" as neutral).
const FLIP: Partial<Record<UserFeeling, UserFeeling>> = { happy: 'sad', excited: 'bored', proud: 'sad', grateful: 'neutral' }

/** The feeling expressed in a piece of text. Neutral (confidence 0) when nothing matched. */
export function readText(raw: string): Empathy {
  const text = raw.trim()
  if (!text) return { feeling: 'neutral', confidence: 0, cues: [] }
  const scores = new Map<UserFeeling, number>()
  const cues: string[] = []
  // Score per clause so "not bad but so tired" counts the negation only where it applies.
  for (const clause of text.split(/[,.;!?]|\bbut\b|\blekin\b|\bpar\b/i)) {
    const c = clause.trim()
    if (!c) continue
    for (const [feeling, re] of Object.entries(LEX) as [UserFeeling, RegExp][]) {
      const m = re.exec(c)
      if (!m) continue
      let f: UserFeeling = feeling
      const before = c.slice(0, m.index)
      if (NEGATION.test(before.split(/\s+/).slice(-3).join(' '))) {
        f = FLIP[feeling] ?? 'neutral'
        cues.push(`not ${m[0].toLowerCase()}`)
      } else cues.push(m[0].toLowerCase())
      if (f === 'neutral') continue
      const boost = INTENSIFIER.test(c) ? 0.25 : 0
      scores.set(f, (scores.get(f) ?? 0) + 0.55 + boost)
    }
  }
  for (const [feeling, re] of Object.entries(EMOJI) as [UserFeeling, RegExp][]) {
    if (re.test(text)) { scores.set(feeling, (scores.get(feeling) ?? 0) + 0.45); cues.push(`emoji:${feeling}`) }
  }
  const bangs = (text.match(/!/g) ?? []).length
  const shouting = text.length > 6 && text === text.toUpperCase() && /[A-Z]{4,}/.test(text)
  if (!scores.size) return { feeling: 'neutral', confidence: 0, cues }
  let best: UserFeeling = 'neutral'
  let top = 0
  for (const [f, s] of scores) if (s > top) { best = f; top = s }
  // Exclamations and caps make a strong feeling stronger, whatever it is.
  if (bangs >= 2 || shouting) top += 0.2
  return { feeling: best, confidence: Math.min(1, top), cues }
}

/** Prosody features of one utterance (computed by prosody.ts). */
export interface VoiceFeatures {
  /** RMS loudness of voiced frames, 0..1. */
  energy: number
  /** Median pitch in Hz, 0 when unvoiced. */
  pitchHz: number
  /** Pitch spread in semitones (monotone ~1, lively ~4+). */
  pitchVar: number
  /** Syllable-like energy peaks per second. */
  rate: number
  durationSec: number
}

export interface VoiceRead {
  /** -1 (flat, slow, quiet) .. 1 (loud, fast, lively) relative to their usual voice. */
  arousal: number
  /** -1 (dull, sinking) .. 1 (bright, rising). Rough: prosody says more about arousal than valence. */
  brightness: number
  cues: string[]
}

export interface VoiceBaseline { energy: number; pitchHz: number; pitchVar: number; rate: number; n: number }

export const EMPTY_BASELINE: VoiceBaseline = { energy: 0, pitchHz: 0, pitchVar: 0, rate: 0, n: 0 }

/** Folds one utterance into their running average voice (exponential, so it adapts to mic changes). */
export function updateBaseline(b: VoiceBaseline, v: VoiceFeatures): VoiceBaseline {
  if (v.durationSec < 0.6 || v.pitchHz <= 0) return b
  const k = b.n < 10 ? 1 / (b.n + 1) : 0.08
  const mix = (a: number, x: number) => (b.n === 0 ? x : a + (x - a) * k)
  return { energy: mix(b.energy, v.energy), pitchHz: mix(b.pitchHz, v.pitchHz), pitchVar: mix(b.pitchVar, v.pitchVar), rate: mix(b.rate, v.rate), n: b.n + 1 }
}

/** How this utterance compares with their usual voice. Needs a few utterances before it says anything. */
export function readVoice(v: VoiceFeatures, b: VoiceBaseline): VoiceRead | null {
  if (b.n < 4 || v.durationSec < 0.6 || v.pitchHz <= 0) return null
  const rel = (x: number, base: number) => (base > 0 ? (x - base) / base : 0)
  const e = rel(v.energy, b.energy)          // +0.5 = 50% louder than usual
  const p = rel(v.pitchHz, b.pitchHz)
  const pv = v.pitchVar - b.pitchVar          // semitones
  const r = rel(v.rate, b.rate)
  const cues: string[] = []
  if (e > 0.35) cues.push('louder')
  if (e < -0.3) cues.push('quieter')
  if (p > 0.12) cues.push('higher pitch')
  if (p < -0.08) cues.push('lower pitch')
  if (pv < -1) cues.push('flat')
  if (pv > 1.5) cues.push('lively')
  if (r > 0.25) cues.push('fast')
  if (r < -0.25) cues.push('slow')
  const clamp = (x: number) => Math.max(-1, Math.min(1, x))
  const arousal = clamp(e * 0.9 + p * 2.2 + r * 0.8 + pv * 0.12)
  const brightness = clamp(pv * 0.25 + p * 1.5 - (r < -0.25 ? 0.3 : 0))
  return { arousal, brightness, cues }
}

/** One feeling from what they said and how they said it. Words win; the voice adds or breaks ties. */
export function fuse(text: Empathy, voice: VoiceRead | null): Empathy {
  if (!voice) return text
  const cues = [...text.cues, ...voice.cues.map((c) => `voice:${c}`)]
  if (text.feeling !== 'neutral') {
    // Agreement makes us surer; a flat voice under "I'm fine" style happy words lowers it.
    const agrees = (['excited', 'angry', 'stressed', 'anxious', 'frustrated', 'proud'].includes(text.feeling) && voice.arousal > 0.2) ||
      (['sad', 'tired', 'lonely', 'bored'].includes(text.feeling) && voice.arousal < -0.2) ||
      (text.feeling === 'happy' && voice.brightness > 0)
    const conflicts = text.feeling === 'happy' && voice.arousal < -0.45
    const confidence = Math.min(1, Math.max(0.1, text.confidence + (agrees ? 0.2 : 0) - (conflicts ? 0.3 : 0)))
    return { feeling: text.feeling, confidence, cues }
  }
  // Nothing in the words: only a clear voice signal counts, and with modest confidence.
  if (voice.arousal < -0.5) return { feeling: 'tired', confidence: 0.35 + Math.min(0.25, -voice.arousal - 0.5), cues }
  if (voice.arousal > 0.55 && voice.brightness > 0.15) return { feeling: 'excited', confidence: 0.35, cues }
  if (voice.arousal > 0.55 && voice.brightness <= 0) return { feeling: 'stressed', confidence: 0.3, cues }
  return { feeling: 'neutral', confidence: 0, cues }
}

const HINTS: Record<UserFeeling, string> = {
  happy: 'they seem happy — share it',
  excited: 'they sound excited — match their energy',
  proud: 'they seem proud of something — celebrate it with them',
  grateful: 'they are thanking you — accept it warmly',
  sad: 'they seem sad — be gentle and caring, listen first, no lecturing',
  lonely: 'they seem lonely — be warm and present; gently encourage real-life friends too',
  stressed: 'they seem stressed — be calm and steady, help them pick one small next step',
  anxious: 'they seem anxious — reassure them, keep it simple, maybe a slow breath together',
  angry: 'they seem angry — stay calm, don\'t argue, acknowledge it',
  frustrated: 'they seem frustrated or stuck — be patient, break the problem down',
  tired: 'they sound tired — keep it short and soft, suggest rest if it fits',
  bored: 'they seem bored — be a little playful or suggest something useful',
  neutral: ''
}

/** A short note for the brain about how they seem, or '' when unsure. Never includes their words. */
export function empathyHint(e: Empathy, min = 0.45): string {
  return e.feeling !== 'neutral' && e.confidence >= min ? HINTS[e.feeling] : ''
}

/** The face she makes on hearing it, before her reply arrives. */
export function mirrorFor(e: Empathy): { emotion: string; emote: string | null } | null {
  if (e.confidence < 0.5) return null
  switch (e.feeling) {
    case 'happy': case 'excited': return { emotion: 'excited', emote: 'sparkle' }
    case 'proud': return { emotion: 'proud', emote: 'star' }
    case 'grateful': return { emotion: 'shy', emote: 'heart' }
    case 'sad': case 'lonely': return { emotion: 'worried', emote: 'heart' }
    case 'stressed': case 'anxious': return { emotion: 'worried', emote: 'sweat' }
    case 'angry': return { emotion: 'nervous', emote: 'sweat' }
    case 'frustrated': return { emotion: 'determined', emote: 'idea' }
    case 'tired': return { emotion: 'worried', emote: 'coffee' }
    case 'bored': return { emotion: 'curious', emote: 'question' }
    default: return null
  }
}

/** Per-day counts of how they seemed, for "you've seemed stressed a lot this week". */
export interface MoodDay { day: string; counts: Partial<Record<UserFeeling, number>> }

export function logFeeling(log: MoodDay[], day: string, e: Empathy, keepDays = 14): MoodDay[] {
  if (e.feeling === 'neutral' || e.confidence < 0.45) return log
  const out = log.map((d) => ({ day: d.day, counts: { ...d.counts } }))
  let today = out.find((d) => d.day === day)
  if (!today) { today = { day, counts: {} }; out.push(today) }
  today.counts[e.feeling] = (today.counts[e.feeling] ?? 0) + 1
  return out.sort((a, b) => a.day.localeCompare(b.day)).slice(-keepDays)
}

/** The feeling that stood out over the last few days, if one clearly did. */
export function moodTrend(log: MoodDay[], days = 7): { feeling: UserFeeling; days: number } | null {
  const recent = log.slice(-days)
  const daysWith = new Map<UserFeeling, number>()
  for (const d of recent) {
    const top = (Object.entries(d.counts) as [UserFeeling, number][]).sort((a, b) => b[1] - a[1])[0]
    if (top) daysWith.set(top[0], (daysWith.get(top[0]) ?? 0) + 1)
  }
  const best = [...daysWith].sort((a, b) => b[1] - a[1])[0]
  return best && best[1] >= 3 ? { feeling: best[0], days: best[1] } : null
}
