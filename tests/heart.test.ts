import { describe, expect, it } from 'vitest'
import { EMPTY_BASELINE, empathyHint, fuse, logFeeling, mirrorFor, moodTrend, readText, readVoice, updateBaseline, type VoiceFeatures } from '../shared/empathy'
import { analyzeUtterance } from '../shared/prosody'
import { appraise, bondLabel, circadian, daysBetween, describe as describeHeart, newAffect, restingEmotion, sanitizeAffect, step } from '../src/core/affect'
import { addFollowUp, detectFollowUp, dueFollowUps, followUpEvent, markAsked, whenFrom } from '../shared/followups'

const MIN = 60000

describe('empathy from words', () => {
  it('reads English, Hinglish and emoji', () => {
    expect(readText("I'm so stressed, too much work").feeling).toBe('stressed')
    expect(readText('aaj bahut dukhi hoon yaar').feeling).toBe('sad')
    expect(readText('thak gaya bhai').feeling).toBe('tired')
    expect(readText('I cleared the interview!!').feeling).toBe('proud')
    expect(readText('ugh this code is not working').feeling).toBe('frustrated')
    expect(readText('😭😭').feeling).toBe('sad')
    expect(readText('open my downloads folder')).toMatchObject({ feeling: 'neutral', confidence: 0 })
  })
  it('handles negation and intensity', () => {
    expect(readText("I'm not happy with my marks").feeling).toBe('sad')
    expect(readText('not tired at all').feeling).toBe('neutral')
    expect(readText('very very sad').confidence).toBeGreaterThan(readText('sad').confidence)
  })
  it('only hints when confident, and never echoes their words', () => {
    expect(empathyHint(readText('so anxious about tomorrow'))).toMatch(/anxious/)
    expect(empathyHint({ feeling: 'sad', confidence: 0.2, cues: [] })).toBe('')
    expect(mirrorFor(readText("I'm so stressed!!"))?.emotion).toBe('worried')
  })
})

/** A synthetic voiced utterance: a sine with harmonics, syllable-like loudness bumps. */
function voice(hz: number, amp: number, syllablesPerSec: number, sec = 1.5, wobble = 0, rate = 16000): Float32Array {
  const n = Math.round(sec * rate)
  const out = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const f = hz * (1 + wobble * Math.sin(2 * Math.PI * 1.3 * t))
    phase += (2 * Math.PI * f) / rate
    const env = 0.35 + 0.65 * Math.max(0, Math.sin(Math.PI * syllablesPerSec * t)) ** 2
    out[i] = amp * env * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase))
  }
  return out
}

describe('prosody', () => {
  it('finds pitch, loudness and pace', () => {
    const f = analyzeUtterance(voice(200, 0.3, 4))
    expect(f.pitchHz).toBeGreaterThan(185)
    expect(f.pitchHz).toBeLessThan(215)
    expect(f.energy).toBeGreaterThan(0.05)
    expect(f.rate).toBeGreaterThan(2)
    expect(f.rate).toBeLessThan(6)
    const low = analyzeUtterance(voice(110, 0.3, 3))
    expect(low.pitchHz).toBeGreaterThan(100)
    expect(low.pitchHz).toBeLessThan(120)
  })
  it('measures pitch spread', () => {
    const flat = analyzeUtterance(voice(200, 0.3, 4, 2, 0))
    const lively = analyzeUtterance(voice(200, 0.3, 4, 2, 0.15))
    expect(lively.pitchVar).toBeGreaterThan(flat.pitchVar + 0.8)
  })
  it('returns zeros for silence and tiny clips', () => {
    expect(analyzeUtterance(new Float32Array(16000)).pitchHz).toBe(0)
    expect(analyzeUtterance(new Float32Array(100)).energy).toBe(0)
  })
})

describe('voice vs their own baseline', () => {
  const usual: VoiceFeatures = { energy: 0.1, pitchHz: 180, pitchVar: 2, rate: 4, durationSec: 2 }
  let b = EMPTY_BASELINE
  for (let i = 0; i < 6; i++) b = updateBaseline(b, usual)

  it('needs a few utterances first', () => {
    expect(readVoice(usual, updateBaseline(EMPTY_BASELINE, usual))).toBeNull()
  })
  it('hears excited vs tired relative to normal', () => {
    const up = readVoice({ energy: 0.16, pitchHz: 215, pitchVar: 4, rate: 5.2, durationSec: 2 }, b)!
    const down = readVoice({ energy: 0.06, pitchHz: 165, pitchVar: 0.8, rate: 2.8, durationSec: 2 }, b)!
    expect(up.arousal).toBeGreaterThan(0.5)
    expect(down.arousal).toBeLessThan(-0.4)
    expect(fuse(readText('ok'), down).feeling).toBe('tired')
    expect(fuse(readText('yay finally'), up).confidence).toBeGreaterThan(readText('yay finally').confidence)
  })
  it('lets a flat voice lower confidence in "happy" words', () => {
    const flat = readVoice({ energy: 0.05, pitchHz: 160, pitchVar: 0.5, rate: 2.5, durationSec: 2 }, b)!
    expect(fuse(readText("I'm happy"), flat).confidence).toBeLessThan(readText("I'm happy").confidence)
  })
})

describe('mood log', () => {
  it('logs confident feelings per day and finds a weekly trend', () => {
    let log = logFeeling([], '2026-10-10', { feeling: 'stressed', confidence: 0.8, cues: [] })
    log = logFeeling(log, '2026-10-10', { feeling: 'happy', confidence: 0.2, cues: [] }) // too unsure: ignored
    log = logFeeling(log, '2026-10-11', { feeling: 'stressed', confidence: 0.7, cues: [] })
    expect(moodTrend(log)).toBeNull()
    log = logFeeling(log, '2026-10-12', { feeling: 'stressed', confidence: 0.6, cues: [] })
    expect(moodTrend(log)).toEqual({ feeling: 'stressed', days: 3 })
    expect(log[0].counts).toEqual({ stressed: 1 })
  })
})

describe('affect engine', () => {
  const t0 = new Date('2026-10-19T11:00:00').getTime()

  it('rises with good things and settles back over time', () => {
    const s0 = newAffect(t0)
    const up = appraise(appraise(s0, 'focus-done', 1, t0), 'praised', 1, t0)
    expect(up.p).toBeGreaterThan(s0.p + 0.4)
    expect(restingEmotion(up).emotion).toMatch(/happy|excited|proud|playful/)
    const later = step(up, t0 + 120 * MIN)
    expect(later.p).toBeLessThan(up.p)
    expect(Math.abs(later.a - 0.05)).toBeLessThan(0.02) // arousal settles within minutes
  })
  it('rests with a soft smile on an ordinary day', () => {
    expect(restingEmotion(newAffect(t0))).toEqual({ emotion: 'happy', intensity: 0.2 })
  })
  it('catches sadness and turns worried-to-sad, never snaps', () => {
    const s = appraise(appraise(newAffect(t0), 'user-sad', 1, t0), 'ignored', 1, t0)
    expect(s.p).toBeLessThan(0)
    expect(['sad', 'lonely', 'worried', 'disappointed', 'hurt']).toContain(restingEmotion(s).emotion)
  })
  it('gets sleepy late at night', () => {
    const night = new Date('2026-10-19T03:00:00').getTime()
    const s = step({ ...newAffect(t0), updatedAt: night - 300 * MIN }, night)
    expect(s.energy).toBeLessThan(0.2)
    expect(restingEmotion(s).emotion).toBe('sleepy')
    expect(circadian(3)).toBeLessThan(circadian(11))
  })
  it('grows the bond slowly: capped per day', () => {
    let s = newAffect(t0)
    for (let i = 0; i < 40; i++) s = appraise(s, 'praised', 1, t0 + i * MIN)
    expect(s.bond - newAffect(t0).bond).toBeCloseTo(3, 5)
    const nextDay = appraise(s, 'praised', 1, t0 + 24 * 60 * MIN)
    expect(nextDay.bond).toBeGreaterThan(s.bond)
    expect(bondLabel(90)).toBe('best friends')
  })
  it('fades the bond a little after days apart, once', () => {
    const s = { ...newAffect(t0), bond: 50 }
    const back = appraise(s, 'returned', 1, t0 + 10 * 24 * 60 * MIN)
    expect(back.bond).toBeLessThan(50)
    expect(back.bond).toBeGreaterThan(45)
    const again = appraise(back, 'talked', 1, t0 + 10 * 24 * 60 * MIN + MIN)
    expect(again.bond).toBeGreaterThanOrEqual(back.bond)
    expect(daysBetween('2026-10-01', '2026-10-11')).toBe(10)
  })
  it('describes itself and survives bad saved data', () => {
    expect(describeHeart(newAffect(t0))).toMatch(/you two are/)
    const s = sanitizeAffect({ p: 9, bond: -4, energy: 'x' }, t0)
    expect(s.p).toBe(1)
    expect(s.bond).toBe(0)
    expect(s.energy).toBeGreaterThan(0)
  })
})

describe('follow-ups', () => {
  const mon = new Date('2026-10-19T10:00:00') // a Monday

  it('reads time words', () => {
    expect(whenFrom('exam tomorrow', mon)).toBe('2026-10-20')
    expect(whenFrom('kal interview hai', mon)).toBe('2026-10-20')
    expect(whenFrom('parso viva hai', mon)).toBe('2026-10-21')
    expect(whenFrom('demo on friday', mon)).toBe('2026-10-23')
    expect(whenFrom('in 3 days', mon)).toBe('2026-10-22')
    expect(whenFrom('someday', mon)).toBeNull()
  })
  it('catches upcoming events, not past ones', () => {
    expect(detectFollowUp('I have my DBMS exam tomorrow', mon)).toMatchObject({ about: 'DBMS exam', dueDay: '2026-10-20', stage: 'luck', askOn: '2026-10-20' })
    expect(detectFollowUp('kal mera Google interview hai', mon)?.about).toBe('Google interview')
    expect(detectFollowUp('I had my exam today', mon)).toBeNull()
    expect(detectFollowUp('my exam is today', mon)).toMatchObject({ stage: 'how', askOn: '2026-10-20' })
    expect(detectFollowUp('I like pizza', mon)).toBeNull()
  })
  it('wishes luck on the day, asks how it went the day after, then stops', () => {
    const f = detectFollowUp('I have my DBMS exam tomorrow', mon)!
    let list = addFollowUp([], { ...f, feeling: 'anxious' }, 'a')
    expect(dueFollowUps(list, mon)).toHaveLength(0)
    const tue = new Date('2026-10-20T09:00:00')
    expect(followUpEvent(dueFollowUps(list, tue)[0])).toMatch(/Wish them luck.*/)
    list = markAsked(list, 'a')
    expect(dueFollowUps(list, tue)).toHaveLength(0)
    const wed = new Date('2026-10-21T09:00:00')
    expect(followUpEvent(dueFollowUps(list, wed)[0])).toMatch(/how it went.*anxious|anxious.*how it went/)
    list = markAsked(list, 'a')
    expect(dueFollowUps(list, wed)).toHaveLength(0)
  })
  it('replaces duplicates and drops stale ones', () => {
    const f = detectFollowUp('maths test on friday', mon)!
    const list = addFollowUp(addFollowUp([], f, 'a'), f, 'b')
    expect(list.map((x) => x.id)).toEqual(['b'])
    expect(dueFollowUps(list, new Date('2026-11-05T09:00:00'))).toHaveLength(0)
  })
})
