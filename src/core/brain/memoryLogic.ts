import type { Fact, Goal, MemoryData, Turn } from '../../../shared/types'

// Pure helpers for memory, kept free of Electron/DOM so they are unit-tested directly.

export const MAX_FACTS = 50
export const MAX_TURNS = 40

export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Adds new facts, replacing near-duplicates (newest wins), keeping the most recent MAX_FACTS. */
export function mergeFacts(existing: Fact[], incoming: string[], now = Date.now()): Fact[] {
  const out = [...existing]
  for (const raw of incoming) {
    const text = raw.trim().replace(/\s+/g, ' ').slice(0, 160)
    if (text.length < 3) continue
    const n = norm(text)
    const words = new Set(n.split(' '))
    const dup = out.findIndex((f) => {
      const m = norm(f.text)
      if (m === n) return true
      const other = new Set(m.split(' '))
      const shared = [...words].filter((w) => other.has(w)).length
      return shared / Math.max(words.size, other.size) >= 0.8
    })
    if (dup >= 0) out.splice(dup, 1)
    out.push({ text, at: now })
  }
  return out.slice(-MAX_FACTS)
}

export function addTurn(turns: Turn[], turn: Turn): Turn[] {
  const last = turns[turns.length - 1]
  // Streaming transcripts arrive in pieces; merge consecutive pieces from the same speaker within 20s.
  if (last && last.role === turn.role && turn.at - last.at < 20000) {
    return [...turns.slice(0, -1), { ...last, text: joinText(last.text, turn.text), at: turn.at }]
  }
  return [...turns, turn].slice(-MAX_TURNS)
}

function joinText(a: string, b: string) {
  if (!a) return b
  if (/^[,.!?;:'’)]/.test(b) || /[\s(]$/.test(a) || /^\s/.test(b)) return a + b
  return `${a} ${b}`
}

/** New day: unfinished goals carry over (still not done), finished ones from earlier days are dropped. */
export function rolloverGoals(goals: Goal[], today = dayKey()): Goal[] {
  return goals.filter((g) => g.day === today || !g.done).map((g) => ({ ...g, day: g.done ? g.day : today }))
}

export function addGoal(goals: Goal[], text: string, today = dayKey()): Goal[] {
  const t = text.trim().slice(0, 120)
  if (!t || goals.some((g) => !g.done && norm(g.text) === norm(t))) return goals
  return [...goals, { id: Math.random().toString(36).slice(2, 9), text: t, done: false, day: today }].slice(-20)
}

/** Marks the best-matching open goal done. Accepts a 1-based index or text. Returns the goal or null. */
export function completeGoal(goals: Goal[], which: string): { goals: Goal[]; done: Goal | null } {
  const open = goals.filter((g) => !g.done)
  let target: Goal | undefined
  const idx = Number.parseInt(which, 10)
  if (!Number.isNaN(idx) && String(idx) === which.trim()) target = open[idx - 1]
  if (!target) {
    const n = norm(which)
    const words = n.split(' ').filter((w) => w.length > 2)
    let best = 0
    for (const g of open) {
      const m = norm(g.text)
      const score = m.includes(n) || n.includes(m) ? 100 : words.filter((w) => m.includes(w)).length
      if (score > best) { best = score; target = g }
    }
  }
  if (!target) return { goals, done: null }
  const done = { ...target, done: true }
  return { goals: goals.map((g) => (g.id === target!.id ? done : g)), done }
}

/** Records a finished focus session and updates the daily streak. */
export function recordSession(streak: MemoryData['streak'], now = new Date()): MemoryData['streak'] {
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getTime() - 86400000))
  let days = streak.days
  let sessionsToday = streak.sessionsToday
  if (streak.lastDay === today) sessionsToday += 1
  else {
    days = streak.lastDay === yesterday ? days + 1 : 1
    sessionsToday = 1
  }
  return { days, lastDay: today, sessionsToday, sessionsTotal: streak.sessionsTotal + 1 }
}

/** Streak as the user should see it today (a missed day shows as broken). */
export function currentStreak(streak: MemoryData['streak'], now = new Date()): number {
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getTime() - 86400000))
  return streak.lastDay === today || streak.lastDay === yesterday ? streak.days : 0
}
