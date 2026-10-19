import { describe, expect, it } from 'vitest'
import { classify } from '../electron/classify'
import { DEFAULT_SETTINGS, EMPTY_MEMORY } from '../shared/types'
import * as mem from '../src/core/brain/memoryLogic'
import { decideNudge, FocusTimer, type NudgeState } from '../src/core/motivation'
import { letterFileName, offlineLetter, parseLetter } from '../src/core/letters'
import { EMOTIONS, faceInfo } from '../src/core/expressions'
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
    now: 10_000_000, dnd: false, talking: false, lastInteractionAt: 0, lastUserAt: 10_000_000 - 5 * MIN, criesSinceMakeup: 0, criesToday: 0, emotionalAttachment: true, lastNudgeAt: {}, lastAnyNudgeAt: 0,
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
  it('sulks after an hour of being ignored, then cries if you keep ignoring her', () => {
    const now = 10_000_000
    const ignored = { category: 'neutral' as const, label: 'Explorer', lastUserAt: now - 61 * MIN }
    expect(decideNudge(base({ ...ignored, lastUserAt: now - 50 * MIN }))?.kind).not.toBe('ignored-sulk')
    expect(decideNudge(base(ignored))?.kind).toBe('ignored-sulk')
    // working, or chatting with her, is not ignoring her
    expect(decideNudge(base({ ...ignored, category: 'work' }))?.kind).not.toBe('ignored-sulk')
    expect(decideNudge(base({ ...ignored, category: 'self' }))?.kind).not.toBe('ignored-sulk')
    // already sulked this time: no repeat, and no crying until 90 min and a gap after the sulk
    const sulked = { ...ignored, lastNudgeAt: { 'ignored-sulk': now - 10 * MIN }, lastAnyNudgeAt: now - 10 * MIN }
    expect(decideNudge(base(sulked))?.kind ?? '').not.toMatch(/ignored/)
    const later = { ...sulked, lastUserAt: now - 95 * MIN, lastNudgeAt: { 'ignored-sulk': now - 30 * MIN } }
    expect(decideNudge(base(later))?.kind).toBe('ignored-cry')
    expect(decideNudge(base({ ...later, lastNudgeAt: { ...later.lastNudgeAt, 'ignored-cry': now - 10 * MIN } }))?.kind ?? '').not.toMatch(/ignored/)
    // talking to her resets it: a fresh hour must pass before the next sulk
    expect(decideNudge(base({ ...ignored, lastNudgeAt: { 'ignored-sulk': now - 120 * MIN } }))?.kind).toBe('ignored-sulk')
    // never during focus, DND, or while you're away from the PC
    expect(decideNudge(base({ ...ignored, focus: { kind: 'focus', endsAt: now + 10 * MIN } }))).toBeNull()
    expect(decideNudge(base({ ...ignored, dnd: true }))).toBeNull()
    expect(decideNudge(base({ ...ignored, idleSeconds: 600 }))).toBeNull()
  })
  it('gets angry instead of crying again once she has cried too much, and only once per stretch', () => {
    const now = 10_000_000
    const due = { category: 'neutral' as const, label: 'Explorer', lastUserAt: now - 150 * MIN, lastNudgeAt: { 'ignored-sulk': now - 90 * MIN, 'ignored-cry': now - 31 * MIN }, lastAnyNudgeAt: now - 31 * MIN }
    expect(decideNudge(base({ ...due, criesSinceMakeup: 1, criesToday: 1 }))?.kind).toBe('ignored-cry')
    expect(decideNudge(base({ ...due, criesSinceMakeup: 2, criesToday: 2 }))?.kind).toBe('ignored-angry')
    // three cries today (even forgiven ones) and the next cry is anger too
    expect(decideNudge(base({ ...due, criesSinceMakeup: 0, criesToday: 3 }))?.kind).toBe('ignored-angry')
    // already angry this stretch: she just huffs, no more nudges
    expect(decideNudge(base({ ...due, criesSinceMakeup: 2, lastNudgeAt: { ...due.lastNudgeAt, 'ignored-angry': now - 20 * MIN } }))).toBeNull()
    // the setting turns all of it off
    expect(decideNudge(base({ ...due, emotionalAttachment: false, criesSinceMakeup: 2 }))?.kind ?? '').not.toMatch(/ignored/)
  })
  it('writes letters that differ, with safe file names', () => {
    let seed = 1
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const ctx = { name: 'Naman', mins: 140, cries: 3, app: 'YouTube', n: 1, recentTitles: [] as string[] }
    const a = offlineLetter(ctx, rng)
    const b = offlineLetter({ ...ctx, recentTitles: [a.title] }, rng)
    expect(a.body).toContain('Naman')
    expect(a.body).toContain('Manyaki')
    expect(a.body).not.toMatch(/\{(name|mins|cries|app|n)\}/)
    expect(b.title).not.toBe(a.title)
    expect(b.body).not.toBe(a.body)
    // no path separators or reserved characters survive
    expect(letterFileName(String.raw`Do You Even Love Me?? 😭 /..\evil:`, new Date(2026, 9, 16, 14, 5))).toBe('2026-10-16 14-05 - Do You Even Love Me ..evil.txt')
    expect(parseLetter('{"title":"Hmph","body":"short"}')).toBeNull()
    expect(parseLetter('not json')).toBeNull()
    expect(parseLetter(JSON.stringify({ title: 'Hmph', body: 'x'.repeat(50) }))?.title).toBe('Hmph')
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
    setUserName: (n) => `name ${n}`,
    openThing: async (k, t) => `${k} ${t}`,
    lookAtScreen: async (q) => `looked: ${q}`
  }
  it('validates arguments and never throws', async () => {
    expect(await runTool(host, 'react', { emotion: 'nope', action: 'dance', emote: 'heart' })).toEqual({ ok: true })
    expect(calls.pop()).toBe('react happy dance heart')
    expect(await runTool(host, 'start_focus', { minutes: 500 })).toEqual({ result: 'focus 120' })
    expect(await runTool(host, 'start_focus', {})).toEqual({ result: 'focus 25' })
    expect(await runTool(host, 'open_folder', { name: 'Downloads' })).toEqual({ result: 'folder Downloads' })
    expect(await runTool(host, 'open_website', { target: 'youtube' })).toEqual({ result: 'website youtube' })
    expect(await runTool(host, 'mystery')).toHaveProperty('error')
  })
})

describe('detailed emotions', () => {
  it('every emotion has an idle loop, and the react tool passes intensity through clamped', async () => {
    for (const e of EMOTIONS) expect(['idle', 'idleHappy', 'shy', 'pout']).toContain(faceInfo(e).idle)
    expect(faceInfo('proud').emote).toBe('star')
    const got: unknown[] = []
    const host = { react: (...a: unknown[]) => got.push(a) } as unknown as ToolHost
    await runTool(host, 'react', { emotion: 'embarrassed', action: 'shy', intensity: 3 })
    await runTool(host, 'react', { emotion: 'lonely', action: 'none' })
    expect(got).toEqual([['embarrassed', 'shy', null, 1], ['lonely', 'none', null, 0.8]])
  })
})

describe('persona', () => {
  it('is professional by default and playful only with emotional attachment on', () => {
    const ctx = { memory: EMPTY_MEMORY, activity: null, shareTitles: false, focus: null }
    const pro = systemInstruction(ctx)
    const fun = systemInstruction({ ...ctx, playful: true })
    expect(pro).toContain('professional assistant')
    expect(pro).not.toContain('hehe", "ehh?')
    expect(fun).toContain('teasing and playful')
    expect(fun).not.toContain('professional assistant')
  })
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

describe('open actions', async () => {
  const { resolveWebsite, matchScore } = await import('../electron/resolve')
  it('turns names, domains and queries into safe https URLs', () => {
    expect(resolveWebsite('YouTube')).toBe('https://www.youtube.com')
    expect(resolveWebsite('github.com/naman')).toBe('https://github.com/naman')
    expect(resolveWebsite('http://example.com')).toBe('https://example.com')
    expect(resolveWebsite('lofi beats on youtube')).toBe('https://www.youtube.com/results?search_query=lofi%20beats')
    expect(resolveWebsite('dsa notes pdf')).toBe('https://www.google.com/search?q=dsa%20notes%20pdf')
    expect(resolveWebsite('javascript:alert(1)')).toMatch(/^https:\/\/www\.google\.com\/search/)
  })
  it('ranks folder/app names sensibly', () => {
    expect(matchScore('maya', 'maya')).toBe(100)
    expect(matchScore('visual studio code', 'Visual Studio Code')).toBe(100)
    expect(matchScore('college notes', 'College Notes 2026')).toBeGreaterThan(matchScore('college notes', 'Notes'))
    expect(matchScore('spotify', 'Steam')).toBe(0)
  })
})
