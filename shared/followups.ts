// "I have my DBMS exam tomorrow" -> on the day she wishes you luck, and the day after she asks how it went.
// Pure and clock-injected (tested).
//
// Only events the user mentions themselves are tracked, in English or Hinglish, with a small set of
// time words. The text kept is a short sanitised phrase ("DBMS exam"), stored in her encrypted memory.

export interface FollowUp {
  id: string
  /** What it is, e.g. "DBMS exam". */
  about: string
  /** Day it happens (YYYY-MM-DD). */
  dueDay: string
  /** 'luck' on the day itself, then 'how' the day after, then 'done'. */
  stage: 'luck' | 'how' | 'done'
  /** First day she may bring it up for the current stage. */
  askOn: string
  /** How they felt when they mentioned it, if known (e.g. "anxious"). */
  feeling?: string
}

const EVENT = /\b(exam|test|quiz|viva|interview|presentation|ppt|deadline|submission|assignment|match|tournament|contest|hackathon|meeting|demo|result|results|paper|practical|placement|oa|online assessment|recital|audition|trip|surgery|appointment)\b/i
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const nextDayKey = (key: string) => dayKey(addDays(new Date(`${key}T12:00:00`), 1))

/** The day an event happens, from time words in the text, or null if none. */
export function whenFrom(text: string, now: Date): string | null {
  const t = text.toLowerCase()
  if (/\b(day after tomorrow|parso|parson)\b/.test(t)) return dayKey(addDays(now, 2))
  if (/\b(today|aaj|tonight|this evening)\b/.test(t)) return dayKey(now)
  if (/\b(tomorrow|tmrw|tmr|kal)\b/.test(t)) return dayKey(addDays(now, 1))
  const inDays = /\bin (\d{1,2}) days?\b/.exec(t) ?? /\b(\d{1,2}) din (mein|me|baad)\b/.exec(t)
  if (inDays) return dayKey(addDays(now, Math.min(30, Number(inDays[1]))))
  if (/\bnext week\b|\bagle hafte\b/.test(t)) return dayKey(addDays(now, 7))
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${DAYS[i]}\\b`).test(t)) {
      let n = (i - now.getDay() + 7) % 7
      if (n === 0) n = 7
      return dayKey(addDays(now, n))
    }
  }
  return null
}

/** A follow-up from something they said, or null. `clean` sanitises the phrase (injected for testability). */
export function detectFollowUp(text: string, now: Date, clean: (s: string) => string = (s) => s): Omit<FollowUp, 'id'> | null {
  const ev = EVENT.exec(text)
  if (!ev) return null
  // Past tense means it already happened ("I had my exam today", "paper de diya").
  const past = /\b(had|was|went|gave|did|finished|got over|ho gaya|ho gayi|de diya|diya tha|tha|thi)\b/i.test(text)
  const future = /\b(will|going to|have (a|my|an)|has (a|my|an)|got (a|my|an)|hai|hoga|hogi|is (on|at|tomorrow|today))\b/i.test(text)
  if (past && !future) return null
  const due = whenFrom(text, now)
  if (!due) return null
  // A couple of words before the event word usually name it ("my DBMS exam", "Google interview").
  const words = text.slice(0, ev.index).replace(/[^\p{L}\p{N}\s+#.-]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  const lead = words.slice(-2).filter((w) => !/^(my|mera|meri|mere|a|an|the|have|has|got|hai|kal|tomorrow|today|aaj|i|ka|ki|ke|is|on|for|parso)$/i.test(w))
  const about = clean([...lead, ev[0].toLowerCase()].join(' ')).slice(0, 60)
  if (!about) return null
  const today = dayKey(now)
  // Today: they just told her, so skip "good luck" and ask tomorrow how it went.
  return due === today
    ? { about, dueDay: due, stage: 'how', askOn: nextDayKey(due) }
    : { about, dueDay: due, stage: 'luck', askOn: due }
}

/** Adds one, replacing an earlier entry about the same thing. Keeps the newest 12. */
export function addFollowUp(list: FollowUp[], f: Omit<FollowUp, 'id'>, id: string): FollowUp[] {
  const same = (x: FollowUp) => x.about.toLowerCase() === f.about.toLowerCase() && x.stage !== 'done'
  return [...list.filter((x) => !same(x)), { ...f, id }].slice(-12)
}

/** Follow-ups she can bring up now (their day has come, within the last week). */
export function dueFollowUps(list: FollowUp[], now: Date): FollowUp[] {
  const today = dayKey(now)
  const weekAgo = dayKey(addDays(now, -7))
  return list.filter((f) => f.stage !== 'done' && f.askOn <= today && f.askOn >= weekAgo)
}

/** What to tell the brain so she brings it up naturally. */
export function followUpEvent(f: FollowUp): string {
  const feel = f.feeling ? ` (they were ${f.feeling} about it)` : ''
  return f.stage === 'luck'
    ? `Today is their ${f.about}${feel}. Wish them luck warmly in one short line.`
    : `They had their ${f.about} recently${feel}. Ask how it went, warmly, in one short line.`
}

/** She brought it up: luck -> ask how it went the day after; how -> done. */
export function markAsked(list: FollowUp[], id: string): FollowUp[] {
  return list.map((f) => {
    if (f.id !== id) return f
    if (f.stage === 'luck') return { ...f, stage: 'how', askOn: nextDayKey(f.dueDay) }
    return { ...f, stage: 'done' }
  })
}
