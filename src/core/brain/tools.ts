import { Behavior, Type, type FunctionDeclaration } from '@google/genai'
import { ACTIONS, type Action } from '../behavior'
import type { Emotion } from '../expressions'
import { EMOTES } from '../fx'

export const EMOTIONS: Emotion[] = ['neutral', 'happy', 'excited', 'sad', 'worried', 'angry', 'pout', 'surprised', 'relaxed', 'shy', 'smug', 'sleepy']

/** What the app can do when the model calls a tool. */
export interface ToolHost {
  react(emotion: Emotion, action: Action, emote: string | null): void
  startFocus(minutes: number): string
  stopFocus(): string
  addGoal(text: string): string
  completeGoal(which: string): string
  remember(fact: string): string
  setUserName(name: string): string
}

export const NON_BLOCKING = new Set(['react'])

export function toolDeclarations(live: boolean): FunctionDeclaration[] {
  const nb = live ? { behavior: Behavior.NON_BLOCKING } : {}
  return [
    {
      name: 'react',
      description: 'Set your facial expression, play a body gesture and optionally pop a little emote above your head. Call this at the start of most replies.',
      ...nb,
      parameters: {
        type: Type.OBJECT,
        properties: {
          emotion: { type: Type.STRING, enum: EMOTIONS },
          action: { type: Type.STRING, enum: ACTIONS },
          emote: { type: Type.STRING, enum: EMOTES, description: 'optional' }
        },
        required: ['emotion', 'action']
      }
    },
    {
      name: 'start_focus',
      description: 'Start a focus (pomodoro) timer when they want to concentrate.',
      parameters: { type: Type.OBJECT, properties: { minutes: { type: Type.NUMBER, description: '1-120, default 25' } } }
    },
    { name: 'stop_focus', description: 'Stop the running focus timer.', parameters: { type: Type.OBJECT, properties: {} } },
    {
      name: 'add_goal',
      description: "Add a task to today's goal list.",
      parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING } }, required: ['text'] }
    },
    {
      name: 'complete_goal',
      description: 'Mark one of today\'s goals as done (by its number or a few words from it).',
      parameters: { type: Type.OBJECT, properties: { which: { type: Type.STRING } }, required: ['which'] }
    },
    {
      name: 'remember',
      description: 'Save a durable fact about them for future conversations (deadlines, exams, preferences, struggles, people they mention).',
      parameters: { type: Type.OBJECT, properties: { fact: { type: Type.STRING } }, required: ['fact'] }
    },
    {
      name: 'set_user_name',
      description: 'Save what they want to be called.',
      parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING } }, required: ['name'] }
    }
  ]
}

/** Executes one tool call; never throws (a bad call becomes an error message the model can see). */
export function runTool(host: ToolHost, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    switch (name) {
      case 'react': {
        const emotion = (EMOTIONS as string[]).includes(String(args.emotion)) ? (args.emotion as Emotion) : 'happy'
        const action = (ACTIONS as string[]).includes(String(args.action)) ? (args.action as Action) : 'none'
        const emote = typeof args.emote === 'string' && EMOTES.includes(args.emote) ? args.emote : null
        host.react(emotion, action, emote)
        return { ok: true }
      }
      case 'start_focus': {
        const m = Math.round(Number(args.minutes) || 25)
        return { result: host.startFocus(Math.max(1, Math.min(120, m))) }
      }
      case 'stop_focus': return { result: host.stopFocus() }
      case 'add_goal': return { result: host.addGoal(String(args.text ?? '')) }
      case 'complete_goal': return { result: host.completeGoal(String(args.which ?? '')) }
      case 'remember': return { result: host.remember(String(args.fact ?? '')) }
      case 'set_user_name': return { result: host.setUserName(String(args.name ?? '')) }
      default: return { error: `unknown tool ${name}` }
    }
  } catch (err) {
    return { error: (err as Error).message }
  }
}
