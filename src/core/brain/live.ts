import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, FunctionResponseScheduling, type LiveServerMessage, type Session } from '@google/genai'
import { NON_BLOCKING, runTool, toolDeclarations, type ToolHost } from './tools'

export interface LiveEvents {
  onAudio(b64: string, mime: string): void
  onHerText(delta: string): void
  onUserText(delta: string): void
  onTurnComplete(): void
  onInterrupted(): void
  onStateChange(state: LiveState, detail?: string): void
}

export type LiveState = 'closed' | 'connecting' | 'open' | 'unavailable' | 'bad-key'

/**
 * One Gemini Live voice session at a time: audio in (16 kHz PCM), audio out (24 kHz PCM) + transcripts,
 * and tool calls for her body/timer/goals/memory. Sessions open on demand and close after quiet time
 * to stay within the free tier; a dropped connection resumes with the server's resumption handle.
 */
export class LiveBrain {
  state: LiveState = 'closed'
  private ai: GoogleGenAI | null = null
  private session: Session | null = null
  private opening: Promise<Session | null> | null = null
  private resumeHandle = ''
  private resumeAt = 0
  private idleTimer = 0
  private unavailableUntil = 0
  private generating = false
  model = 'gemini-3.8-live'
  voiceName = 'Leda'
  lastError = ''
  connectMs = 0

  constructor(
    private readonly ev: LiveEvents,
    private readonly tools: ToolHost,
    private readonly instruction: () => string,
    private readonly log: (m: string) => void
  ) {}

  setKey(key: string) {
    this.close()
    this.ai = key ? new GoogleGenAI({ apiKey: key }) : null
    this.unavailableUntil = 0
    this.set(key ? 'closed' : 'bad-key')
  }

  /** Live is usable right now (key present, not rate-limited / failed recently). */
  get usable() {
    return !!this.ai && this.state !== 'bad-key' && Date.now() > this.unavailableUntil
  }

  get isOpen() { return this.state === 'open' && !!this.session }
  get busy() { return this.generating }

  private set(s: LiveState, detail?: string) {
    if (this.state === s && !detail) return
    this.state = s
    this.ev.onStateChange(s, detail)
  }

  /** Returns an open session, connecting if necessary. */
  async ensure(): Promise<Session | null> {
    if (this.session && this.state === 'open') { this.touch(); return this.session }
    if (this.opening) return this.opening
    if (!this.usable) return null
    this.opening = this.connect().finally(() => { this.opening = null })
    return this.opening
  }

  private async connect(): Promise<Session | null> {
    if (!this.ai) return null
    this.set('connecting')
    const t0 = performance.now()
    const resume = this.resumeHandle && Date.now() - this.resumeAt < 120000 ? this.resumeHandle : undefined
    try {
      const session = await this.ai.live.connect({
        model: this.model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } } },
          systemInstruction: this.instruction(),
          tools: [{ functionDeclarations: toolDeclarations(true) }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          sessionResumption: resume ? { handle: resume } : {},
          contextWindowCompression: { slidingWindow: {} },
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
              prefixPaddingMs: 120,
              silenceDurationMs: 550
            }
          }
        },
        callbacks: {
          onopen: () => undefined,
          onmessage: (m) => this.onMessage(m),
          onerror: (e) => {
            this.lastError = (e as ErrorEvent).message ?? 'error'
            this.log(`live error: ${this.lastError}`)
          },
          onclose: (e) => this.onClose(e.code, e.reason)
        }
      })
      this.session = session
      this.connectMs = Math.round(performance.now() - t0)
      this.set('open')
      this.touch()
      return session
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      this.log(`live connect failed: ${msg}`)
      this.classifyFailure(msg)
      return null
    }
  }

  private classifyFailure(msg: string) {
    this.lastError = msg
    if (/api key|API_KEY|permission|unauthori[sz]ed|401|403/i.test(msg)) this.set('bad-key', msg)
    else {
      // Quota, unknown model, network: back off and let the fallback brain handle things for a while.
      const quota = /quota|exhaust|429|rate/i.test(msg)
      this.unavailableUntil = Date.now() + (quota ? 15 : 2) * 60000
      this.set('unavailable', msg)
    }
  }

  private onClose(code: number, reason: string) {
    const was = this.session
    this.session = null
    this.generating = false
    clearTimeout(this.idleTimer)
    if (!was) return
    this.log(`live closed ${code} ${reason}`)
    if (code === 1000 || code === 1005) this.set('closed')
    else if (reason) this.classifyFailure(`${code} ${reason}`)
    else this.set('closed')
  }

  private onMessage(m: LiveServerMessage) {
    this.touch()
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      this.resumeHandle = m.sessionResumptionUpdate.newHandle
      this.resumeAt = Date.now()
    }
    if (m.goAway) {
      // Server will drop us soon; reconnect lazily on next use with the resumption handle.
      this.log(`live goAway ${m.goAway.timeLeft}`)
    }
    if (m.toolCall?.functionCalls?.length) {
      const responses = m.toolCall.functionCalls.map((fc) => {
        const response = runTool(this.tools, fc.name ?? '', (fc.args ?? {}) as Record<string, unknown>)
        return {
          id: fc.id,
          name: fc.name,
          response,
          ...(NON_BLOCKING.has(fc.name ?? '') ? { scheduling: FunctionResponseScheduling.SILENT } : {})
        }
      })
      this.session?.sendToolResponse({ functionResponses: responses })
    }
    const c = m.serverContent
    if (!c) return
    if (c.interrupted) {
      this.generating = false
      this.ev.onInterrupted()
    }
    if (c.inputTranscription?.text) this.ev.onUserText(c.inputTranscription.text)
    for (const part of c.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
        this.generating = true
        this.ev.onAudio(part.inlineData.data, part.inlineData.mimeType)
      }
    }
    if (c.outputTranscription?.text) this.ev.onHerText(c.outputTranscription.text)
    if (c.turnComplete) {
      this.generating = false
      this.ev.onTurnComplete()
    }
  }

  sendAudio(b64: string) {
    this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } })
    this.touch()
  }

  endAudio() {
    this.session?.sendRealtimeInput({ audioStreamEnd: true })
  }

  /** Typed message or an [EVENT] notice; she answers out loud. */
  async sendText(text: string): Promise<boolean> {
    const s = await this.ensure()
    if (!s) return false
    s.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true })
    this.touch()
    return true
  }

  /** Close after 60 s with nothing said either way. */
  private touch() {
    clearTimeout(this.idleTimer)
    this.idleTimer = window.setTimeout(() => {
      if (this.generating) return this.touch()
      this.close()
    }, 60000)
  }

  close() {
    clearTimeout(this.idleTimer)
    const s = this.session
    this.session = null
    this.generating = false
    if (s) {
      try { s.close() } catch { /* ignore */ }
      this.set('closed')
    }
  }
}
