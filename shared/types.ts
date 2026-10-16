// Types shared by the Electron main process, the preload bridge and the renderer.

export type AppCategory = 'work' | 'distraction' | 'neutral' | 'self'

export interface Rect { x: number; y: number; width: number; height: number }

export interface ActivitySnapshot {
  app: string            // owner app name, e.g. "Code", "chrome"
  title: string          // full window title (stays local unless shareTitles is on)
  category: AppCategory
  label: string          // short human label, e.g. "VS Code", "YouTube"
  bounds: Rect | null    // window bounds in screen DIPs (null for our own window / desktop)
  maximized: boolean
  fullscreen: boolean    // a fullscreen app (game/video) is in front: she should hide
  idleSeconds: number    // system-wide time since last keyboard/mouse input
}

export interface DisplayInfo {
  bounds: Rect           // full display in DIPs (the overlay window covers this)
  workArea: Rect         // display minus taskbar; workArea bottom = top edge of the taskbar
  scaleFactor: number
}

export type MicMode = 'handsfree' | 'toggle' | 'off'

export interface Settings {
  voiceName: string              // Gemini Live prebuilt voice
  liveModel: string
  textModel: string
  micMode: MicMode
  size: number                   // her height in DIPs
  dnd: boolean
  shareTitles: boolean           // send full window titles to the model (off by default)
  launchAtLogin: boolean
  voiceMuted: boolean            // she replies in the bubble only, no audio
  neuralVoice: boolean           // opt-in local Kokoro voice for offline use (needs a decent GPU)
  checkInMinutes: number
  focusMinutes: number
  breakMinutes: number
  categoryRules: { work: string[]; distraction: string[] }
  onboarded: boolean
}

export interface Fact { text: string; at: number }
export interface Goal { id: string; text: string; done: boolean; day: string }
export interface Turn { role: 'user' | 'her'; text: string; at: number }

export interface MemoryData {
  version: number
  userName: string
  facts: Fact[]
  goals: Goal[]
  turns: Turn[]
  summary: string
  streak: { days: number; lastDay: string; sessionsToday: number; sessionsTotal: number }
  focus: { endsAt: number; kind: 'focus' | 'break'; minutes: number } | null
}

export const DEFAULT_SETTINGS: Settings = {
  voiceName: 'Leda',
  liveModel: 'gemini-3.8-live',
  textModel: 'gemini-3.8-flash',
  micMode: 'handsfree',
  size: 260,
  dnd: false,
  shareTitles: false,
  launchAtLogin: true,
  voiceMuted: false,
  neuralVoice: false,
  checkInMinutes: 12,
  focusMinutes: 25,
  breakMinutes: 5,
  categoryRules: {
    work: ['code', 'visual studio', 'intellij', 'pycharm', 'webstorm', 'android studio', 'terminal', 'powershell',
      'cmd', 'windows terminal', 'word', 'excel', 'powerpoint', 'notion', 'obsidian', 'figma', 'docs', 'sheets',
      'slides', 'overleaf', 'leetcode', 'github', 'stack overflow', 'jupyter', 'colab', 'claude', 'chatgpt', 'acrobat', 'pdf'],
    distraction: ['youtube', 'instagram', 'netflix', 'reddit', 'twitter', ' x ', 'facebook', 'tiktok', 'prime video',
      'hotstar', 'twitch', 'discord', 'steam', 'epic games', 'valorant', 'minecraft', 'spotify', 'whatsapp', 'telegram']
  },
  onboarded: false
}

export const EMPTY_MEMORY: MemoryData = {
  version: 1,
  userName: '',
  facts: [],
  goals: [],
  turns: [],
  summary: '',
  streak: { days: 0, lastDay: '', sessionsToday: 0, sessionsTotal: 0 },
  focus: null
}

// The surface the preload script exposes on window.manyaki.
export interface Bridge {
  platform: string
  debug: boolean
  getDisplay(): Promise<DisplayInfo>
  /** true: the window is a small rect that follows her (normal); false: it covers the display (debug). */
  followWindow: boolean
  /** Move/resize the window (display-relative DIPs). Returns the bounds the OS actually applied. */
  setWindowRect(r: Rect): Rect
  setIgnoreMouse(ignore: boolean): void
  setFocusable(focusable: boolean): void
  getApiKey(): Promise<string>
  setApiKey(key: string): Promise<boolean>
  hasApiKey(): Promise<boolean>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  getMemory(): Promise<MemoryData>
  setMemory(data: MemoryData): Promise<void>
  wipeMemory(): Promise<void>
  exportMemory(): Promise<string | null>
  notify(title: string, body: string): void
  openSettings(): void
  /** Open the Home control window. */
  openHome(): void
  quit(): void
  /** Send a command to her (from the Home window). */
  sendCommand(cmd: Command): void
  /** Overlay -> Home window status updates. */
  reportStatus(s: Status): void
  /** Right-click menu with her controls (mic, mute, DND, focus, size, settings, quit). */
  showMenu(): void
  listAnims(): Promise<string[]>
  /** Open a folder, app or website on the computer (open-only; nothing destructive). */
  runAction(kind: 'folder' | 'app' | 'website', target: string): Promise<{ ok: boolean; opened?: string; error?: string }>
  log(level: 'info' | 'warn' | 'error', msg: string): void
  on(channel: 'activity', cb: (a: ActivitySnapshot) => void): () => void
  on(channel: 'display', cb: (d: DisplayInfo) => void): () => void
  on(channel: 'settings', cb: (s: Settings) => void): () => void
  on(channel: 'command', cb: (cmd: Command) => void): () => void
  on(channel: 'memory', cb: (m: MemoryData) => void): () => void
  on(channel: 'cursor', cb: (p: { x: number; y: number }) => void): () => void
  on(channel: 'status', cb: (s: Status) => void): () => void
  on(channel: 'tab', cb: (tab: string) => void): () => void
}

/** What she is doing right now, reported by the overlay to the Home window about once a second. */
export interface Status {
  mood: string
  mode: string                 // stand | walk | sit | sleep | act | ...
  conv: string                 // none | listening | thinking | talking
  brain: 'live' | 'connecting' | 'fallback' | 'no-key' | 'bad-key' | 'offline'
  mic: 'on' | 'off' | 'blocked'
  hidden: boolean
  timer: { kind: 'focus' | 'break'; endsAt: number; minutes: number } | null
  activity: string             // "VS Code (work)"
  lastLine: string             // what she last said
}

export type Command =
  | { type: 'toggle-listen' }
  | { type: 'focus-start'; minutes?: number }
  | { type: 'focus-stop' }
  | { type: 'corner' }
  | { type: 'say-hi' }
  | { type: 'chat' }
  | { type: 'reload-key' }
  | { type: 'hide'; minutes: number }
  | { type: 'show' }
  | { type: 'say'; text: string }
  | { type: 'come-here' }
  | { type: 'reset' }
