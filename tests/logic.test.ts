import { describe, expect, it } from 'vitest'
import { classify } from '../electron/classify'
import { DEFAULT_SETTINGS, EMPTY_MEMORY } from '../shared/types'
import * as mem from '../src/core/brain/memoryLogic'
import { decideNudge, FocusTimer, type NudgeState } from '../src/core/motivation'
import { runTool, type ToolHost } from '../src/core/brain/tools'
import { systemInstruction } from '../src/core/brain/persona'
import { splitSentences } from '../src/core/voice/localVoice'
import { slotForFile } from '../src/core/anim/clips'

const rules = DEFAULT_SETTINGS.categoryRules
const MIN = 60000

describe('app classifier', () => {
  it('labels and categorises common apps', () => {
    expect(classify('Code.exe', 'main.ts - project - Visual Studio Code', rules)).toEqual({ category: 'work', label: 'VS Code' })
    expect(classify('chrome.exe', 'lofi beats - YouTube - Google Chrome', rules)).toEqual({ category: 'distraction', label: 'YouTube' })
    expect(classify('chrome.exe', 'Two Sum - LeetCode', rules)).toEqual({ category: 'work', label: 'LeetCode' })
    expect(classify('notepad.exe', 'Untitled - Notepad', rules).category).toBe('neutral')
  })
  it('lets distraction win when a work keyword also matches', () => {
    expect(classify('chrome.exe', 'GitHub tutorial - YouTube', rules).category).toBe('distraction')
  })
})

describe('memory', () => {
  it('merges near-duplicate facts, newest wins, capped', () => {
    let f = mem.mergeFacts([], ['Has a DSA exam on Nov 3'], 1)
    f = mem.mergeFacts(f, ['has a DSA exam on Nov 3!', 'Likes matcha'], 2)
    expect(f.map((x) => x.text)).toEqual(['has a DSA exam on Nov 3!', 'Likes matcha'])
    const many = mem.mergeFacts([], Array.from({ length: 70 }, (_, i) => `fact number ${i} about unique topic${i}`))
    expect(many).toHaveLength(mem.MAX_FACTS)
  })
  it('merges streaming transcript pieces from the same speaker', () => {
    let t = mem.addTurn([], { role: 'user', text: 'I finished', at: 1000 })
    t = mem.addTurn(t, { role: 'user', text: 'my homework!', at: 2000 })
    t = mem.addTurn(t, { role: 'her', text: 'Yay', at: 3000 })
    expect(t).toEqual([{ role: 'user', text: 'I finished my homework!', at: 2000 }, { role: 'her', text: 'Yay', at: 3000 }])
  })
  it('handles goals: add, dedupe, complete by index or words, rollover', () => {
    let g = mem.addGoal([], 'Finish physics assignment', '2026-10-15')
    g = mem.addGoal(g, 'finish physics assignment', '2026-10-15')
    g = mem.addGoal(g, 'Read chapter 4', '2026-10-15')
    expect(g).toHaveLength(2)
    const r1 = mem.completeGoal(g, '2')
    expect(r1.done?.text).toBe('Read chapter 4')
    const r2 = mem.completeGoal(r1.goals, 'the physics one')
    expect(r2.done?.text).toBe('Finish physics assignment')
    const rolled = mem.rolloverGoals([...g, { id: 'x', text: 'old done', done: true, day: '2026-10-10' }], '2026-10-16')
    expect(rolled.map((x) => [x.text, x.day])).toEqual([['Finish physics assignment', '2026-10-16'], ['Read chapter 4', '2026-10-16']])
  })
  it('tracks daily streaks across days', () => {
    const d = (s: string) => new Date(`${s}T10:00:00`)
    let s = mem.recordSession(EMPTY_MEMORY.streak, d('2026-10-14'))
    s = mem.recordSession(s, d('2026-10-14'))
    expect(s).toMatchObject({ days: 1, sessionsToday: 2, sessionsTotal: 2 })
    s = mem.recordSession(s, d('2026-10-15'))
    expect(s).toMatchObject({ days: 2, sessionsToday: 1 })
    expect(mem.currentStreak(s, d('2026-10-16'))).toBe(2)
    expect(mem.currentStreak(s, d('2026-10-18'))).toBe(0)
    s = mem.recordSession(s, d('2026-10-18'))
    expect(s.days).toBe(1)
  })
})

describe('motivation', () => {
  const base = (over: Partial<NudgeState> = {}): NudgeState => ({
    now: 10_000_000, dnd: false, talking: false, lastInteractionAt: 0, lastNudgeAt: {}, lastAnyNudgeAt: 0,
    focus: null, category: 'work', label: 'VS Code', categorySince: 10_000_000 - 5 * MIN, workStreakSince: null,
    idleSeconds: 0, checkInMinutes: 12, openGoals: 0, hour: 15, ...over
  })
  it('stays quiet in DND, while talking, or when you are away', () => {
    expect(decideNudge(base({ dnd: true }))).toBeNull()
    expect(decideNudge(base({ talking: true }))).toBeNull()
    expect(decideNudge(base({ idleSeconds: 600 }))).toBeNull()
  })
  it('teases you for drifting to a distraction during focus, then gets firmer', () => {
    const focus = { kind: 'focus' as const, endsAt: 10_000_000 + 12 * MIN }
    expect(decideNudge(base({ focus, category: 'distraction', label: 'YouTube', categorySince: 10_000_000 - 2 * MIN }))).toBeNull()
    expect(decideNudge(base({ focus, category: 'distraction', label: 'YouTube', categorySince: 10_000_000 - 4 * MIN }))?.kind).toBe('focus-distracted')
    expect(decideNudge(base({ focus, category: 'distraction', label: 'YouTube', categorySince: 10_000_000 - 11 * MIN }))?.kind).toBe('focus-distracted-firm')
    // working during focus: silence
    expect(decideNudge(base({ focus }))).toBeNull()
  })
  it('respects the check-in gap and praises long work streaks', () => {
    expect(decideNudge(base({ lastInteractionAt: 10_000_000 - 5 * MIN }))).toBeNull()
    expect(decideNudge(base({ workStreakSince: 10_000_000 - 55 * MIN }))?.kind).toBe('worked-long')
  })
  it('nudges to sleep late at night', () => {
    expect(decideNudge(base({ hour: 2, lastInteractionAt: 10_000_000 - 20 * MIN }))?.kind).toBe('late-night')
  })
  it('focus timer fires once at the end and survives clock jumps', () => {
    const t = new FocusTimer()
    const ended: string[] = []
    t.onEnd = (k) => ended.push(k)
    t.start('focus', 25, 0)
    t.tick(24 * MIN)
    expect(t.label(24 * MIN)).toBe('🎯 focus 1:00')
    t.tick(90 * MIN) // laptop slept through the end
    t.tick(91 * MIN)
    expect(ended).toEqual(['focus'])
  })
})

describe('tools', () => {
  const calls: string[] = []
  const host: ToolHost = {
    react: (e, a, emote) => calls.push(`react ${e} ${a} ${emote}`),
    startFocus: (m) => `focus ${m}`,
    stopFocus: () => 'stopped',
    addGoal: (t) => `goal ${t}`,
    completeGoal: (w) => `done ${w}`,
    remember: (f) => `rem ${f}`,
    setUserName: (n) => `name ${n}`
  }
  it('validates arguments and never throws', () => {
    expect(runTool(host, 'react', { emotion: 'nope', action: 'dance', emote: 'heart' })).toEqual({ ok: true })
    expect(calls.pop()).toBe('react happy dance heart')
    expect(runTool(host, 'start_focus', { minutes: 500 })).toEqual({ result: 'focus 120' })
    expect(runTool(host, 'start_focus', {})).toEqual({ result: 'focus 25' })
    expect(runTool(host, 'mystery')).toHaveProperty('error')
  })
})

describe('persona', () => {
  it('includes name, goals, facts, focus and only the app label unless titles are shared', () => {
    const memory = { ...EMPTY_MEMORY, userName: 'Naman', facts: [{ text: 'DSA exam Nov 3', at: 1 }], goals: [{ id: 'a', text: 'Revise graphs', done: false, day: mem.dayKey() }] }
    const activity = { app: 'chrome', title: 'secret doc title', category: 'work' as const, label: 'the browser', bounds: null, maximized: false, fullscreen: false, idleSeconds: 0 }
    const p = systemInstruction({ memory, activity, shareTitles: false, focus: { kind: 'focus', minutesLeft: 12 } })
    expect(p).toContain('THEIR NAME: Naman')
    expect(p).toContain('Revise graphs')
    expect(p).toContain('DSA exam Nov 3')
    expect(p).toContain('12 min left')
    expect(p).toContain('the browser (work)')
    expect(p).not.toContain('secret doc title')
    expect(p).toContain('Hinglish')
    expect(systemInstruction({ memory, activity, shareTitles: true, focus: null })).toContain('secret doc title')
  })
})

describe('misc', () => {
  it('splits speech into sentences and merges tiny fragments', () => {
    expect(splitSentences('Hehe! You did it. Want a break?')).toEqual(['Hehe! You did it.', 'Want a break?'])
  })
  it('maps Mixamo file names to animation slots', () => {
    expect(slotForFile('manyaki-asset://anims/Happy%20Idle.fbx')).toBe('idleHappy')
    expect(slotForFile('x/Sitting Idle.fbx')).toBe('sit')
    expect(slotForFile('x/Sit To Stand.fbx')).toBe('sitToStand')
    expect(slotForFile('x/Walking.fbx')).toBe('walk')
    expect(slotForFile('x/Shaking Head No.fbx')).toBe('shake')
    expect(slotForFile('x/Random.fbx')).toBeNull()
  })
})
