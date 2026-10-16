import type { AppCategory } from '../../shared/types'
import type { Action } from './behavior'
import type { Emotion } from './expressions'

// The motivation loop: when she should speak up on her own, and what about. Pure decision logic so
// it can be unit-tested with a fake clock; the companion turns a Nudge into speech.

export type NudgeKind =
  | 'focus-distracted' | 'focus-distracted-firm' | 'distracted-long' | 'worked-long' | 'check-in'
  | 'late-night' | 'water' | 'welcome-back'

export interface Nudge { kind: NudgeKind; event: string }

export interface NudgeState {
  now: number
  dnd: boolean
  talking: boolean                       // a conversation is in progress or she is mid-sentence
  lastInteractionAt: number              // last time either of you spoke
  lastNudgeAt: Partial<Record<NudgeKind, number>>
  lastAnyNudgeAt: number
  focus: { kind: 'focus' | 'break'; endsAt: number } | null
  category: AppCategory | null
  label: string
  categorySince: number                  // when the current app category started
  workStreakSince: number | null         // continuous work (no distraction, not idle) started
  idleSeconds: number
  checkInMinutes: number
  openGoals: number
  hour: number
}

const MIN = 60000

export function decideNudge(s: NudgeState): Nudge | null {
  if (s.dnd || s.talking || s.idleSeconds > 120) return null
  const since = (k: NudgeKind) => s.now - (s.lastNudgeAt[k] ?? 0)
  const onCat = s.now - s.categorySince
  const inFocus = s.focus?.kind === 'focus'
  const leftMin = s.focus ? Math.max(0, Math.round((s.focus.endsAt - s.now) / MIN)) : 0

  // During a focus session she stays quiet unless you wander off to a distraction.
  if (inFocus) {
    if (s.category === 'distraction') {
      if (onCat > 10 * MIN && since('focus-distracted-firm') > 8 * MIN) {
        return { kind: 'focus-distracted-firm', event: `They have been on ${s.label} for ${Math.round(onCat / MIN)} minutes even though they're in a focus session (${leftMin} min left). Be a bit firmer (still sweet): ask them to close it and come back.` }
      }
      if (onCat > 3 * MIN && since('focus-distracted') > 6 * MIN && since('focus-distracted-firm') > 6 * MIN) {
        return { kind: 'focus-distracted', event: `They switched to ${s.label} during their focus session (${leftMin} min left) and have been there ${Math.round(onCat / MIN)} minutes. Tease them gently to get back to work.` }
      }
    }
    return null
  }

  const quietFor = s.now - Math.max(s.lastInteractionAt, s.lastAnyNudgeAt)
  const gap = s.checkInMinutes * MIN

  if ((s.hour >= 1 && s.hour < 5) || (s.hour === 0 && new Date(s.now).getMinutes() >= 30)) {
    if (since('late-night') > 50 * MIN && quietFor > 10 * MIN) {
      return { kind: 'late-night', event: `It's ${s.hour === 0 ? 'past midnight' : `${s.hour} AM`} and they're still up. You're getting sleepy too. Gently tell them to wrap up and sleep.` }
    }
  }
  if (quietFor < gap) return null

  if (s.category === 'distraction' && onCat > 25 * MIN && since('distracted-long') > 40 * MIN) {
    return { kind: 'distracted-long', event: `They've been on ${s.label} for ${Math.round(onCat / MIN)} minutes.${s.openGoals ? ` They still have ${s.openGoals} goal(s) open today.` : ''} Playfully suggest getting back to it (maybe a focus session together).` }
  }
  if (s.workStreakSince && s.now - s.workStreakSince > 50 * MIN && since('worked-long') > 50 * MIN) {
    return { kind: 'worked-long', event: `They've been working steadily for ${Math.round((s.now - s.workStreakSince) / MIN)} minutes. Tell them you're proud and suggest a short break: stretch, water, rest their eyes.` }
  }
  if (since('water') > 90 * MIN && since('check-in') > gap) {
    return { kind: 'water', event: 'Remind them cutely to drink some water (and maybe fix their posture).' }
  }
  if (since('check-in') > gap * 1.5) {
    return {
      kind: 'check-in',
      event: s.openGoals
        ? `A quiet moment. They're in ${s.label || 'something'}. Check in briefly — how is it going with their goals? (${s.openGoals} open)`
        : `A quiet moment. They're in ${s.label || 'something'}. Say something light and warm, or ask what they're working on.`
    }
  }
  return null
}

/** Timestamp-based focus timer (robust to sleep/throttling: it compares clocks, never counts ticks). */
export class FocusTimer {
  state: { kind: 'focus' | 'break'; endsAt: number; minutes: number } | null = null
  onEnd?: (kind: 'focus' | 'break', minutes: number) => void

  start(kind: 'focus' | 'break', minutes: number, now = Date.now()) {
    this.state = { kind, minutes, endsAt: now + minutes * MIN }
  }

  stop() { this.state = null }

  remainingMs(now = Date.now()) { return this.state ? Math.max(0, this.state.endsAt - now) : 0 }

  label(now = Date.now()) {
    if (!this.state) return ''
    const ms = this.remainingMs(now)
    const m = Math.floor(ms / MIN)
    const s = Math.floor((ms % MIN) / 1000)
    return `${this.state.kind === 'focus' ? '🎯 focus' : '☕ break'} ${m}:${String(s).padStart(2, '0')}`
  }

  tick(now = Date.now()) {
    if (this.state && now >= this.state.endsAt) {
      const { kind, minutes } = this.state
      this.state = null
      this.onEnd?.(kind, minutes)
    }
  }
}

/** Offline lines, used when no AI is reachable so she never goes silent. */
export const OFFLINE_LINES: Record<NudgeKind | 'hello' | 'poke' | 'headpat' | 'offline-reply' | 'focus-start' | 'focus-end' | 'break-end', { text: string[]; emotion: Emotion; action: Action }> = {
  hello: { text: ["Hi hi! I'm here with you~", "Hey! Let's do our best today!", 'Yay, you\'re here!'], emotion: 'happy', action: 'wave' },
  poke: { text: ['Hehe, that tickles!', 'Eh? What is it~?', 'Boop!'], emotion: 'happy', action: 'jump' },
  headpat: { text: ['Ehehe… more pats please.', 'Mmm~ that\'s nice.', 'You\'re gonna spoil me!'], emotion: 'shy', action: 'headpat' },
  'offline-reply': { text: ["I can't hear the internet right now… but I'm still right here!", "My brain's offline, but I'm cheering for you anyway!"], emotion: 'worried', action: 'shake' },
  'focus-start': { text: ["Okay, focus mode! I'll be quiet and watch. You've got this!", "Let's go! I'll guard you from distractions."], emotion: 'excited', action: 'cheer' },
  'focus-end': { text: ['Yay, session done! I\'m so proud of you!', 'You did it! Take a little break, okay?'], emotion: 'excited', action: 'cheer' },
  'break-end': { text: ['Break\'s over~ ready for another round?', 'Okay, back to it! I believe in you!'], emotion: 'happy', action: 'nod' },
  'focus-distracted': { text: ['Heyyy… isn\'t this focus time? Back to work~', 'I saw that! Close it, close it!'], emotion: 'pout', action: 'pout' },
  'focus-distracted-firm': { text: ['Okay, seriously, let\'s go back. I\'ll wait right here!'], emotion: 'angry', action: 'shake' },
  'distracted-long': { text: ['Wanna do a focus session together? Just 25 minutes~'], emotion: 'smug', action: 'think' },
  'worked-long': { text: ['You\'ve been working so hard! Stretch with me?'], emotion: 'happy', action: 'stretch' },
  'check-in': { text: ['How\'s it going over there?', 'Still with me? Hehe.'], emotion: 'happy', action: 'wave' },
  'late-night': { text: ['It\'s really late… let\'s sleep soon, okay?'], emotion: 'sleepy', action: 'none' },
  water: { text: ['Water break! Drink some water for me~'], emotion: 'happy', action: 'nod' },
  'welcome-back': { text: ['Welcome back! I missed you~', 'Oh! You\'re back!'], emotion: 'excited', action: 'wave' }
}

export const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
