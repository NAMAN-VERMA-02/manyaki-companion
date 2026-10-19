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
  /** Hands a task to the Manyaki Eyes browser extension (private details stay on the PC). */
  browserTask(task: string): Promise<string>
  /** Desktop hands (windows, apps' controls, keys, mouse) and eyes (what's on screen). */
  desk(op: DeskOp, args: Record<string, unknown>): Promise<string>
  /** Searches her private memory (bullets on this PC) for what's relevant to a question. */
  recall(query: string): Promise<string>
}

export type DeskOp = 'see_screen' | 'list_windows' | 'window' | 'close_windows' | 'read_app' | 'press_control' | 'type_into' | 'type_text' | 'press_keys' | 'click_on' | 'scroll'
const DESK_OPS = new Set<string>(['see_screen', 'list_windows', 'window', 'close_windows', 'read_app', 'press_control', 'type_into', 'type_text', 'press_keys', 'click_on', 'scroll'])

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
      name: 'browser_task',
      description: 'Do something for them on the web page open in their browser (fill a form, search a site, click through steps, sign in) using your browser helper, Manyaki Eyes. It hides their private details on their PC before anything is planned. Only when they ask you to do something in the browser or on a page. Pass their request in their own words, including any details they gave.',
      parameters: { type: Type.OBJECT, properties: { task: { type: Type.STRING, description: 'what to do on the page' } }, required: ['task'] }
    },
    // ---- desktop: she can see the screen and work any app, like a person at the keyboard ----
    {
      name: 'see_screen',
      description: 'What is on their screen right now: the app in front and its visible text (read on their PC, private details hidden). Instant. Use it whenever what they say depends on what they are looking at.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    {
      name: 'list_windows',
      description: 'The windows open on their computer (app and title).',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    {
      name: 'window',
      description: 'Do something to one window: focus (switch to it), close, minimize, maximize, restore, snap_left, snap_right, snap_top, snap_bottom or center. "which" is words from its app name or title ("chrome", "the youtube one", "vs code"), or "this" for the one in front.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          which: { type: Type.STRING },
          action: { type: Type.STRING, enum: ['focus', 'close', 'minimize', 'maximize', 'restore', 'snap_left', 'snap_right', 'snap_top', 'snap_bottom', 'center'] }
        },
        required: ['which', 'action']
      }
    },
    {
      name: 'close_windows',
      description: 'Close every window that matches (e.g. "chrome" closes all Chrome windows). Apps may ask to save first.',
      parameters: { type: Type.OBJECT, properties: { which: { type: Type.STRING } }, required: ['which'] }
    },
    {
      name: 'read_app',
      description: 'Read the controls of an app window (buttons, fields, tabs, menu items) with ids, to operate it. Defaults to the window in front. Read again after the app changes.',
      parameters: { type: Type.OBJECT, properties: { which: { type: Type.STRING, description: 'optional window to read' } } }
    },
    {
      name: 'press_control',
      description: 'Press, toggle or select a control by its id from read_app.',
      parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING } }, required: ['id'] }
    },
    {
      name: 'type_into',
      description: 'Put text into a field by its id from read_app (replaces what is there). Hidden details like [[EMAIL_1]] can be used as-is: the real value is filled in on their PC.',
      parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, text: { type: Type.STRING } }, required: ['id', 'text'] }
    },
    {
      name: 'type_text',
      description: 'Type text where the cursor is, in any app. Use \\n for Enter.',
      parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING } }, required: ['text'] }
    },
    {
      name: 'press_keys',
      description: 'Press a key or shortcut: "ctrl+s", "ctrl+shift+t", "alt+tab", "win+d", "enter", "esc", "f5", "playpause", "volumeup".',
      parameters: { type: Type.OBJECT, properties: { keys: { type: Type.STRING } }, required: ['keys'] }
    },
    {
      name: 'click_on',
      description: 'Click the visible text on screen that matches (a button, link, tab or menu item label). Use when read_app has no matching control.',
      parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING }, double: { type: Type.BOOLEAN } }, required: ['text'] }
    },
    {
      name: 'scroll',
      description: 'Scroll the page in the window in front: up/down by some notches, or jump to the top/bottom of the page.',
      parameters: { type: Type.OBJECT, properties: { direction: { type: Type.STRING, enum: ['up', 'down', 'top', 'bottom'] }, amount: { type: Type.NUMBER, description: '1-15 notches, default 3 (about a third of a screen)' } }, required: ['direction'] }
    },
    {
      name: 'recall_memory',
      description: 'Search your private memory of them (kept on their PC) for what is relevant: their plans, preferences, people, routines, past conversations. Use it when they ask what you remember or when an answer depends on something they told you before. Takes a moment.',
      parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ['query'] }
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
      case 'browser_task': return { result: await host.browserTask(String(args.task ?? '')) }
      case 'recall_memory': return { result: await host.recall(String(args.query ?? '')) }
      default:
        if (DESK_OPS.has(name)) return { result: await host.desk(name as DeskOp, args) }
        return { error: `unknown tool ${name}` }
    }
  } catch (err) {
    return { error: (err as Error).message }
  }
}
