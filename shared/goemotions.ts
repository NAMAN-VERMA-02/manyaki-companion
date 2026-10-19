import type { Empathy, UserFeeling } from './empathy'

// The on-device classifier speaks GoEmotions (28 labels, Google's dataset of 58k human-labelled
// sentences). These tables translate it into how the user feels, and into her own face for a line she
// says. Pure (tested).

export type GoScores = Record<string, number>

const TO_USER: Record<string, UserFeeling> = {
  admiration: 'happy', amusement: 'happy', approval: 'happy', caring: 'happy', joy: 'happy', love: 'happy', optimism: 'happy', relief: 'happy',
  excitement: 'excited', desire: 'excited', surprise: 'excited', curiosity: 'neutral',
  pride: 'proud', gratitude: 'grateful',
  sadness: 'sad', grief: 'sad', disappointment: 'sad', remorse: 'sad',
  fear: 'anxious', nervousness: 'anxious', embarrassment: 'anxious',
  anger: 'angry', disgust: 'angry', annoyance: 'frustrated', disapproval: 'frustrated', confusion: 'frustrated',
  realization: 'neutral', neutral: 'neutral'
}

/** Their feeling from classifier scores: the strongest feeling, unless "neutral" clearly dominates. */
export function userFeeling(s: GoScores): Empathy {
  const sum = new Map<UserFeeling, number>()
  for (const [label, p] of Object.entries(s)) {
    const f = TO_USER[label]
    if (f) sum.set(f, (sum.get(f) ?? 0) + p)
  }
  const neutral = sum.get('neutral') ?? 0
  sum.delete('neutral')
  const [best, p] = [...sum].sort((a, b) => b[1] - a[1])[0] ?? ['neutral', 0]
  const cues = Object.entries(s).filter(([, v]) => v >= 0.15).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `model:${k} ${v.toFixed(2)}`)
  if (p < 0.3 || p < neutral * 0.6) return { feeling: 'neutral', confidence: 0, cues }
  return { feeling: best as UserFeeling, confidence: Math.min(1, p), cues }
}

/**
 * The classifier is English-only. For Hindi/Hinglish (or when it's unsure) the word lists decide;
 * when both have an opinion, the more confident one wins and agreement raises confidence.
 */
export function blend(model: Empathy | null, words: Empathy): Empathy {
  if (!model || model.feeling === 'neutral') return words
  if (words.feeling === 'neutral') return model
  if (words.feeling === model.feeling) return { ...model, confidence: Math.min(1, Math.max(model.confidence, words.confidence) + 0.15), cues: [...model.cues, ...words.cues] }
  return model.confidence >= words.confidence ? model : words
}

const TO_HER: Record<string, string> = {
  admiration: 'proud', amusement: 'playful', anger: 'angry', annoyance: 'grumpy', approval: 'happy', caring: 'love',
  confusion: 'confused', curiosity: 'curious', desire: 'excited', disappointment: 'disappointed', disapproval: 'pout',
  disgust: 'grumpy', embarrassment: 'embarrassed', excitement: 'excited', fear: 'scared', gratitude: 'grateful',
  grief: 'sad', joy: 'happy', love: 'love', nervousness: 'nervous', optimism: 'determined', pride: 'proud',
  realization: 'surprised', relief: 'relaxed', remorse: 'sad', sadness: 'sad', surprise: 'surprised', neutral: 'neutral'
}

/** Her face for something she's about to say, from the classifier's reading of the line. */
export function herFace(s: GoScores): { emotion: string; intensity: number } {
  const [label, p] = Object.entries(s).filter(([k]) => k !== 'neutral').sort((a, b) => b[1] - a[1])[0] ?? ['neutral', 0]
  if (p < 0.2) return { emotion: 'happy', intensity: 0.3 }
  return { emotion: TO_HER[label] ?? 'happy', intensity: Math.max(0.3, Math.min(1, p * 1.2)) }
}
