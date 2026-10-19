import { Behavior, Type, type FunctionDeclaration } from '@google/genai'
import { ACTIONS, type Action } from '../behavior'
import { EMOTIONS, type Emotion } from '../expressions'
import { EMOTES } from '../fx'

export { EMOTIONS }

/** What the app can do when the model calls a tool. */
export interface ToolHost {
  react(emotion: Emotion, action: Action, emote: string | null, intensity?: number): void
  startFocus(minutes: number): string
  stopFocus(): string
  addGoal(text: string): string
  completeGoal(which: string): string
  remember(fact: string): string
  setUserName(name: string): string
  /** Opens something on the computer, with her little laptop animation. Resolves with what happened. */
  openThing(kind: 'folder' | 'app' | 'website', target: string): Promise<string>
  /** Takes one screenshot (only right after the user asked) and returns what is on it. */
  lookAtScreen(question: string): Promise<string>
}

export const NON_BLOCKING = new Set(['react'])

export function toolDeclarations(live: boolean): FunctionDeclaration[] {
  const nb = live ? { behavior: Behavior.NON_BLOCKING } : {}
  return [
    {
      name: 'react',
      description: 'Set your facial expression, play a body gesture and optionally pop a little emote above your head. Call this at the start of most replies. Pick the most specific emotion that fits (e.g. proud for their win, curious for a question, nervous before a test, embarrassed when teased, lonely when they were gone, determined when starting work) and how strongly you feel it.',
      ...nb,
      parameters: {
        type: Type.OBJECT,
        properties: {
          emotion: { type: Type.STRING, enum: [...EMOTIONS] },
          action: { type: Type.STRING, enum: ACTIONS },
          emote: { type: Type.STRING, enum: EMOTES, description: 'optional' },
          intensity: { type: Type.NUMBER, description: 'optional, 0.2 (a hint of it) to 1 (fully), default 0.8' }
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
      name: 'open_folder',
      description: 'Open a folder on their computer in File Explorer when they ask (e.g. Downloads, Desktop, Documents, or a folder by name like "maya" or "college notes").',
      parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: 'folder name or full path' } }, required: ['name'] }
    },
    {
      name: 'open_app',
      description: 'Launch an installed app when they ask (e.g. VS Code, Chrome, Spotify, Notepad, Calculator, Settings, WhatsApp).',
      parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING } }, required: ['name'] }
    },
    {
      name: 'open_website',
      description: 'Open a website or search in their browser (e.g. "youtube", "github.com", "lofi beats on youtube", or any search query).',
      parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING } }, required: ['target'] }
    },
    {
      name: 'look_at_screen',
      description: 'Take ONE screenshot of their screen to see what they are asking about (an error, code, a game, a page). Only when they ask you to look/see/check something on their screen.',
      parameters: { type: Type.OBJECT, properties: { question: { type: Type.STRING, description: 'what they want to know about it' } }, required: ['question'] }
    },
    {
      name: 'set_user_name',
      description: 'Save what they want to be called.',
      parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING } }, required: ['name'] }
    }
  ]
}

/** Executes one tool call; never throws (a bad call becomes an error message the model can see). */
export async function runTool(host: ToolHost, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case 'react': {
        const emotion = (EMOTIONS as readonly string[]).includes(String(args.emotion)) ? (args.emotion as Emotion) : 'happy'
        const action = (ACTIONS as string[]).includes(String(args.action)) ? (args.action as Action) : 'none'
        const emote = typeof args.emote === 'string' && EMOTES.includes(args.emote) ? args.emote : null
        const n = Number(args.intensity)
        host.react(emotion, action, emote, Number.isFinite(n) ? Math.max(0.2, Math.min(1, n)) : 0.8)
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
      case 'open_folder': return { result: await host.openThing('folder', String(args.name ?? '')) }
      case 'open_app': return { result: await host.openThing('app', String(args.name ?? '')) }
      case 'open_website': return { result: await host.openThing('website', String(args.target ?? '')) }
      case 'look_at_screen': return { result: await host.lookAtScreen(String(args.question ?? '')) }
      default: return { error: `unknown tool ${name}` }
    }
  } catch (err) {
    return { error: (err as Error).message }
  }
}
