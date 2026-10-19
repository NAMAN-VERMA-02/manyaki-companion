import { describe, expect, it } from 'vitest'
import { blend, herFace, userFeeling } from '../shared/goemotions'
import { readText } from '../shared/empathy'
import { ANNOYED, learn, newLearn, probabilities, rewardFrom, sanitizeLearn, type Context } from '../src/core/learn'

describe('GoEmotions mapping', () => {
  it('turns classifier scores into how they feel', () => {
    expect(userFeeling({ sadness: 0.62, grief: 0.1, neutral: 0.2 })).toMatchObject({ feeling: 'sad' })
    expect(userFeeling({ nervousness: 0.3, fear: 0.25, neutral: 0.3 })).toMatchObject({ feeling: 'anxious' })
    expect(userFeeling({ pride: 0.7 })).toMatchObject({ feeling: 'proud' })
    expect(userFeeling({ neutral: 0.9, joy: 0.05 })).toMatchObject({ feeling: 'neutral', confidence: 0 })
  })
  it('lets word lists handle Hinglish and agree with the model', () => {
    const words = readText('aaj bahut dukhi hoon')
    expect(blend(null, words).feeling).toBe('sad')
    expect(blend({ feeling: 'neutral', confidence: 0, cues: [] }, words).feeling).toBe('sad')
    const agree = blend({ feeling: 'sad', confidence: 0.6, cues: [] }, words)
    expect(agree.confidence).toBeGreaterThan(0.6)
  })
  it('reads her own line into a face', () => {
    expect(herFace({ gratitude: 0.8 })).toMatchObject({ emotion: 'grateful' })
    expect(herFace({ curiosity: 0.5, neutral: 0.4 })).toMatchObject({ emotion: 'curious' })
    expect(herFace({ neutral: 0.95 })).toEqual({ emotion: 'happy', intensity: 0.3 })
  })
})

const top = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0][0]

describe('learning how to react', () => {
  const happy: Context = { feeling: 'happy', confidence: 0.8, lateNight: false, playful: true }

  it('starts from kind instincts', () => {
    expect(top(probabilities(newLearn(), { feeling: 'sad', confidence: 0.9, lateNight: false, playful: false }))).toBe('comfort')
    expect(top(probabilities(newLearn(), { feeling: 'proud', confidence: 0.9, lateNight: false, playful: false }))).toBe('celebrate')
  })
  it('changes with your feedback: rewarded reactions grow, punished ones fade', () => {
    let s = newLearn()
    const before = probabilities(s, happy)
    for (let i = 0; i < 40; i++) {
      s = learn(s, happy, 'tease', rewardFrom('headpat'))
      s = learn(s, happy, 'match', rewardFrom('annoyed'))
    }
    const after = probabilities(s, happy)
    expect(after.tease).toBeGreaterThan(before.tease * 2)
    expect(after.match).toBeLessThan(before.match / 2)
    expect(s.lessons).toBe(80)
    // Learning about "happy" leaves "sad" mostly alone.
    expect(top(probabilities(s, { feeling: 'sad', confidence: 0.9, lateNight: false, playful: true }))).toBe('comfort')
  })
  it('one odd moment barely moves her', () => {
    const s = learn(newLearn(), happy, 'match', rewardFrom('stop'))
    expect(probabilities(s, happy).match).toBeGreaterThan(probabilities(newLearn(), happy).match * 0.6)
  })
  it('survives bad saved data and spots annoyance', () => {
    expect(sanitizeLearn({ w: { tease: ['x'] }, baseline: 99 }).baseline).toBe(1)
    expect(sanitizeLearn(null).lessons).toBe(0)
    expect(ANNOYED.test("stop that, you're annoying")).toBe(true)
    expect(ANNOYED.test('bas karo yaar')).toBe(true)
    expect(ANNOYED.test('that was nice')).toBe(false)
  })
})
