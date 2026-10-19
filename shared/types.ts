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
  /** auto: Gemini when online, local brain when offline. private: always local, nothing leaves the PC. */
  brainMode: 'auto' | 'private'
  /** Live streaming: she never says their name, facts or window titles out loud. */
  streamSafe: boolean
  /** Games count as work (streamers / pro players), so she doesn't nag during gaming. */
  gamingIsWork: boolean
  voiceMuted: boolean            // she replies in the bubble only, no audio
  /** Ignored for an hour she sulks, then cries; cry too much and she gets angry and writes you letters. */
  emotionalAttachment: boolean
  checkInMinutes: number
  focusMinutes: number
  breakMinutes: number
  categoryRules: { work: string[]; distraction: string[] }
  onboarded: boolean
  /** Host the Manyaki Eyes server for the browser extension. */
  eyesEnabled: boolean
  /** Who plans browser actions: auto (Ollama if installed, else Gemini, else rules), or one of them. */
  eyesPlanner: 'auto' | 'ollama' | 'gemini' | 'rules'
  /**
   * Privacy shield: before anything about the screen leaves this PC (a screenshot, text read from it),
   * private details are found on-device and hidden. The one privacy switch on the main menu.
   */
  privacyShield: boolean
  /** She keeps an eye on the screen (read on this PC, never stored) so she knows what you're doing. */
  screenSense: boolean
  /** Lower frame rates to save battery (Advanced). */
  batterySaver: boolean
}

/** What she last saw on screen (on-device OCR, private details masked). Lives in memory only. */
export interface Glance {
  app: string
  title: string
  lines: string[]
  /** An error message visible on screen, if any (for a gentle offer to help). */
  error: string | null
  at: number
  /** A password manager, bank or private-browsing window: not read at all. */
  private: boolean
}

export type WindowOp = 'focus' | 'close' | 'minimize' | 'maximize' | 'restore' | 'snap_left' | 'snap_right' | 'snap_top' | 'snap_bottom' | 'center'

/** Her hands on the desktop (electron/desk.ts). Every method resolves with a short result for the brain. */
export interface DeskBridge {
  windows(): Promise<string>
  windowAction(query: string, op: WindowOp): Promise<string>
  closeAll(query: string): Promise<string>
  readApp(query?: string): Promise<string>
  press(id: string): Promise<string>
  typeInto(id: string, text: string): Promise<string>
  type(text: string): Promise<string>
  keys(combo: string): Promise<string>
  scroll(direction: 'up' | 'down', amount?: number): Promise<string>
  clickText(text: string, double?: boolean): Promise<string>
  seeScreen(): Promise<string>
  /** One screenshot for a vision model, redacted on this PC when the privacy shield is on. */
  screenshot(): Promise<{ image: string; hidden: number } | { error: string }>
}

/** The browser agent server she hosts (see electron/eyes.ts). */
export interface EyesInfo {
  running: boolean
  port: number
  pairing: string
  planner: string
  /** The extension polled in the last ~40 s. */
  connected: boolean
  error: string
}

/** Progress reported by the extension, relayed to her. Never contains private values. */
export interface EyesEventMsg {
  kind: 'connected' | 'task' | 'step' | 'done' | 'error' | 'ask'
  task?: string
  detail?: string
  step?: number
  redactions?: number
  ms?: number
}

import type { FollowUp } from './followups'
import type { MoodDay, VoiceBaseline } from './empathy'
import type { Usage } from './patterns'

/** One bullet of her memory. `uses`: how often it helped answer something (ranks it higher). */
export interface Fact { text: string; at: number; uses?: number; kind?: 'fact' | 'routine' }
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
  /** Her inner state (src/core/affect.ts): mood, energy and how close she feels to them. */
  affect: unknown
  /** Things they mentioned that she should ask about later (exams, interviews…). */
  followUps: FollowUp[]
  /** How they seemed each day (counts of feelings), last 14 days. */
  moodLog: MoodDay[]
  /** Their usual voice (loudness, pitch, pace), so she can tell when they sound different. */
  voiceBaseline: VoiceBaseline
  /** Minutes per app per hour of the week, to learn their routines (on this PC). */
  usage: Usage
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
  brainMode: 'auto',
  streamSafe: false,
  gamingIsWork: false,
  voiceMuted: false,
  emotionalAttachment: false,
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
  onboarded: false,
  eyesEnabled: true,
  eyesPlanner: 'auto',
  privacyShield: true,
  screenSense: true,
  batterySaver: false
}

export const EMPTY_MEMORY: MemoryData = {
  version: 1,
  userName: '',
  facts: [],
  goals: [],
  turns: [],
  summary: '',
  streak: { days: 0, lastDay: '', sessionsToday: 0, sessionsTotal: 0 },
  focus: null,
  affect: null,
  followUps: [],
  moodLog: [],
  voiceBaseline: { energy: 0, pitchHz: 0, pitchVar: 0, rate: 0, n: 0 },
  usage: { apps: {}, days: {} }
}

// The surface the preload script exposes on window.manyaki.
export interface Bridge {
  platform: string
  /** User profile folder, used to mask personal paths before anything leaves the PC. */
  homeDir: string
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
  /** Save one of her angry letters to Desktop\Letters from Manyaki; a notification opens it. */
  writeLetter(fileName: string, body: string): Promise<{ ok: boolean; path?: string; error?: string }>
  openSettings(): void
  /** Open the Home control window. */
  openHome(): void
  quit(): void
  /** One JPEG (base64) of the primary screen; only called when the user asks her to look. */
  captureScreen(): Promise<string | null>
  /** Offline brain (runs on this PC). */
  local: {
    status(): Promise<LocalStatus | null>
    download(): Promise<LocalStatus>
    warm(system?: string): Promise<LocalStatus | null>
    chat(system: string, history: { role: 'user' | 'her'; text: string }[], text: string, teach?: boolean): Promise<LocalReply>
    transcribe(audio: Float32Array): Promise<{ text: string; ms: number }>
    tts(text: string, voice: string): Promise<{ samples: Float32Array; rate: number; ms: number }>
  }
  /** Desktop control: windows, apps' controls, keys, mouse, screen. */
  desk: DeskBridge
  /** Browser agent (Manyaki Eyes): queue a task for the extension, read the server's state. */
  eyes: {
    task(text: string): Promise<boolean>
    info(): Promise<EyesInfo>
    newPairing(): Promise<EyesInfo>
    /** Opens the folder to "Load unpacked" from. Resolves with the path (or why it failed). */
    openExtensionFolder(): Promise<string>
  }
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
  on(channel: 'local-status', cb: (s: LocalStatus) => void): () => void
  on(channel: 'eyes', cb: (e: EyesEventMsg) => void): () => void
  on(channel: 'glance', cb: (g: Glance | null) => void): () => void
}

export interface LocalStatus {
  llm: 'missing' | 'downloading' | 'ready' | 'loaded'
  asr: 'missing' | 'downloading' | 'ready' | 'loaded'
  tts: 'missing' | 'downloading' | 'ready' | 'loaded'
  progress: number
  gpu: string
  error: string
}

export interface LocalReply { say: string; ms: number }

/** What she is doing right now, reported by the overlay to the Home window about once a second. */
export interface Status {
  mood: string
  mode: string                 // stand | walk | sit | sleep | act | ...
  conv: string                 // none | listening | thinking | talking
  brain: 'live' | 'connecting' | 'fallback' | 'local' | 'no-key' | 'bad-key' | 'offline'
  mic: 'on' | 'off' | 'blocked'
  hidden: boolean
  timer: { kind: 'focus' | 'break'; endsAt: number; minutes: number } | null
  activity: string             // "VS Code (work)"
  lastLine: string             // what she last said
  /** Her inner state for the Home window's mood card. */
  heart: {
    bond: number               // 0..100
    bondLabel: string
    energy: number             // 0..1
    pleasure: number           // -1..1
    arousal: number            // -1..1
    feeling: string            // her resting emotion
    youSeem: string            // how the user last seemed ('' when unsure)
    trend: string              // e.g. "stressed 4 of the last 7 days"
  }
  /** Browser agent (Manyaki Eyes) activity, when the extension is connected. */
  eyes: { connected: boolean; task: string; step: string; redactions: number } | null
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
  | { type: 'look'; question?: string }
