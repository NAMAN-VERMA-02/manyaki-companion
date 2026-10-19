// Manyaki Eyes wire protocol (scheme "manyaki-eyes/1"), shared by the browser extension and the server.
//
// The client never sends a private value. Every value it hides becomes a typed token such as [[EMAIL_1]]
// (the same value always gets the same token within a task), listed in `redactions` with its kind and
// where it was on screen. The server can refer to tokens in actions ("type [[EMAIL_1]] into e7") and the
// client puts the real value back locally just before typing it.

export const SCHEME = 'manyaki-eyes/1'

export type PIIType =
  | 'PASSWORD' | 'EMAIL' | 'PHONE' | 'CARD' | 'CVV' | 'AADHAAR' | 'PAN' | 'IFSC' | 'SSN' | 'BANK_ACCOUNT' | 'UPI'
  | 'IP' | 'SECRET' | 'OTP' | 'DOB' | 'ADDRESS' | 'PINCODE' | 'NAME' | 'FACE' | 'PASSPORT' | 'TEXT_IN_IMAGE'

export interface Box { x: number; y: number; w: number; h: number }

/** How a sensitive thing was found: DOM attributes, a text pattern, context words, a model. */
export type DetectionSource = 'dom' | 'regex' | 'context' | 'ner' | 'face' | 'ocr'

export interface Redaction {
  token: string            // [[EMAIL_1]]
  type: PIIType
  boxes: Box[]             // viewport CSS pixels; empty when off-screen
  source: DetectionSource
  /** Element it belongs to, when known. */
  elementId?: string
  confidence: number
}

export type Role =
  | 'button' | 'link' | 'textbox' | 'password' | 'checkbox' | 'radio' | 'select' | 'option' | 'tab' | 'menuitem'
  | 'heading' | 'image' | 'text' | 'textarea' | 'switch' | 'slider' | 'searchbox' | 'other'

export interface ScreenElement {
  id: string               // e12: stable for the page's lifetime
  role: Role
  tag: string
  /** Visible label (aria-label, <label>, placeholder, text…), tokenised. */
  label: string
  /** Current value of a field, tokenised; "[[PASSWORD_1]]" for secrets; omitted when empty. */
  value?: string
  box: Box
  checked?: boolean
  disabled?: boolean
  /** For links: host only (paths and query strings often carry ids). */
  href?: string
  /** Set when the element itself holds sensitive data. */
  sensitive?: PIIType
  /** select options (tokenised), capped. */
  options?: string[]
}

export interface StepRequest {
  scheme: typeof SCHEME
  task: string             // tokenised too: the user may type their own email into the task
  page: { host: string; title: string; viewport: { w: number; h: number }; scrollY: number; scrollMax: number }
  elements: ScreenElement[]
  /** Visible prose that isn't an element (headings, paragraphs), tokenised and capped. */
  text: string[]
  /** Where each `text` entry is on screen (same order), for grounding ("the post about X"). */
  textBoxes?: Box[]
  /** Local vision results: a caption of the screen and text found in pixels (images, canvas). */
  vision?: { caption?: string; ocr?: { text: string; box: Box }[]; model?: string }
  redactions: Redaction[]
  /** Redacted JPEG (base64) when the user allows screenshots to be sent; never the original. */
  image?: string
  history: HistoryItem[]
  step: number
}

export interface HistoryItem { action: AgentAction; ok: boolean; note?: string }

export type AgentAction =
  | { type: 'click'; id: string }
  | { type: 'type'; id: string; text: string; submit?: boolean }
  | { type: 'select'; id: string; option: string }
  | { type: 'check'; id: string; checked: boolean }
  | { type: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { type: 'navigate'; url: string }
  | { type: 'wait'; ms: number }
  | { type: 'ask_user'; question: string }
  | { type: 'done'; summary: string }

export interface StepResponse {
  thought: string
  actions: AgentAction[]
  /** Which model planned this, for the client's metrics. */
  model: string
  ms: number
  /** Server-side leak guard: private-looking strings the server found (and masked) in the request. */
  leaks?: number
  error?: string
}

/** Token text for a redaction: [[EMAIL_1]]. */
export const tokenFor = (type: PIIType, n: number) => `[[${type}_${n}]]`
export const TOKEN_RE = /\[\[([A-Z_]+)_(\d+)\]\]/g
