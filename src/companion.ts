import type { ActivitySnapshot, Bridge, Command, MemoryData, Settings } from '../shared/types'
import type { Stage, ClickZone } from './stage'
import type { Action } from './core/behavior'
import type { Emotion } from './core/expressions'
import { AudioOut } from './core/voice/audioOut'
import { Mic, floatToPcm16Base64 } from './core/voice/mic'
import { LocalVoice } from './core/voice/localVoice'
import { LiveBrain, type LiveState } from './core/brain/live'
import { TextBrain } from './core/brain/text'
import type { ToolHost } from './core/brain/tools'
import { EVENT_PREFIX, systemInstruction } from './core/brain/persona'
import * as mem from './core/brain/memoryLogic'
import { decideNudge, FocusTimer, OFFLINE_LINES, pick, type NudgeKind } from './core/motivation'

/**
 * The companion: ties her ears, voice, brain, memory and motivation loop to the body on stage.
 */
export class Companion implements ToolHost {
  private settings!: Settings
  private memory!: MemoryData
  private readonly audio = new AudioOut()
  private readonly local: LocalVoice
  private readonly mic: Mic
  private readonly live: LiveBrain
  private readonly text: TextBrain
  private readonly timer = new FocusTimer()
  private activity: ActivitySnapshot | null = null
  private hasKey = false

  // conversation state
  private herText = ''
  private userText = ''
  private pendingFrames: Float32Array[] = []
  private streaming = false
  private speechEndAt = 0
  private firstAudioMs = 0
  private thinkingTimer = 0
  private userTurnsSinceDistill = 0
  private lastInteractionAt = Date.now()
  private lastAnyNudgeAt = Date.now()
  private lastNudgeAt: Partial<Record<NudgeKind, number>> = {}
  private categorySince = Date.now()
  private workStreakSince: number | null = null
  private wasIdle = false
  private toggleListening = false
  private saveTimer = 0
  private micError = ''
  private keyRejected = false

  constructor(private readonly bridge: Bridge, private readonly stage: Stage) {
    const log = (m: string) => bridge.log('warn', m)
    this.local = new LocalVoice(this.audio, log)
    this.text = new TextBrain(this, log)
    this.live = new LiveBrain(
      {
        onAudio: (b64, mime) => this.onHerAudio(b64, mime),
        onHerText: (d) => this.onHerText(d),
        onUserText: (d) => this.onUserText(d),
        onTurnComplete: () => this.onTurnComplete(),
        onInterrupted: () => this.audio.stop(),
        onStateChange: (s, detail) => this.onLiveState(s, detail)
      },
      this,
      () => this.instruction(),
      log
    )
    this.mic = new Mic({
      onSpeechStart: (pre) => this.onSpeechStart(pre),
      onFrame: (f) => this.onMicFrame(f),
      onSpeechEnd: (audio) => this.onSpeechEnd(audio),
      onError: (msg) => {
        this.micError = msg
        bridge.log('warn', `mic: ${msg}`)
        stage.chip.set("I can't hear you (mic blocked?) — double-click me to type 💌", '', 8000)
      }
    })
    this.audio.onEnded(() => this.onAudioDrained())
  }

  async start() {
    this.settings = await this.bridge.getSettings()
    this.memory = await this.bridge.getMemory()
    this.memory.goals = mem.rolloverGoals(this.memory.goals)
    if (this.memory.focus && this.memory.focus.endsAt > Date.now()) {
      this.timer.state = { ...this.memory.focus }
      this.stage.body.focus = this.memory.focus.kind === 'focus'
    }
    this.applySettings(this.settings)
    await this.loadKey()

    this.timer.onEnd = (kind, minutes) => this.onTimerEnd(kind, minutes)
    this.stage.onFrame = (dt) => this.frame(dt)
    this.stage.onClick = (zone, n) => this.onClick(zone, n)
    this.stage.onDoubleClick = () => this.openChat()
    this.stage.body.onLanded = (hard) => this.onLanded(hard)
    this.setupChat()

    this.bridge.on('activity', (a) => this.onActivity(a))
    this.bridge.on('settings', (s) => this.applySettings(s))
    this.bridge.on('command', (c) => this.onCommand(c))
    this.bridge.on('memory', (m) => { this.memory = m })

    setInterval(() => this.timer.tick(), 1000)
    setInterval(() => this.considerNudge(), 20000)
    window.addEventListener('online', () => this.stage.chip.set('back online ✨', '', 2500))

    this.local.onProgress = (p) => { if (p < 1) this.stage.chip.set(`downloading my offline voice… ${Math.round(p * 100)}%`, '', 3000) }
    // Greet once she has landed.
    setTimeout(() => this.greet(), 2600)
  }

  // ---------------- setup ----------------

  private async loadKey() {
    const key = await this.bridge.getApiKey()
    this.hasKey = !!key
    this.keyRejected = false
    this.live.setKey(key)
    this.text.setKey(key)
    this.local.cloud = key ? (t) => this.text.tts(t, this.settings.voiceName) : null
    if (this.settings.neuralVoice) this.local.warmUp()
  }

  private applySettings(s: Settings) {
    const prev = this.settings
    this.settings = s
    this.live.model = s.liveModel
    this.live.voiceName = s.voiceName
    this.text.model = s.textModel
    this.stage.setSize(s.size)
    this.stage.body.dnd = s.dnd
    if (s.neuralVoice) this.local.warmUp()
    if (prev?.voiceName !== s.voiceName) this.live.close()
    void this.syncMic()
  }

  private async syncMic() {
    const want = !this.settings.dnd && (this.settings.micMode === 'handsfree' || (this.settings.micMode === 'toggle' && this.toggleListening))
    if (want && !this.mic.enabled) await this.mic.start()
    else if (!want && this.mic.enabled) await this.mic.stop()
  }

  private instruction() {
    return systemInstruction({
      memory: this.memory,
      activity: this.activity,
      shareTitles: this.settings.shareTitles,
      focus: this.timer.state ? { kind: this.timer.state.kind, minutesLeft: Math.round(this.timer.remainingMs() / 60000) } : null
    })
  }

  // ---------------- listening ----------------

  private onSpeechStart(preRoll: Float32Array[]) {
    // Barge-in: you started talking, so she stops.
    if (this.audio.speaking || this.local.systemSpeaking) {
      this.audio.stop()
      this.local.stop()
      this.stage.face.set('surprised', 600)
    }
    this.userText = ''
    this.lastInteractionAt = Date.now()
    this.stage.body.setConv('listening')
    this.stage.chip.set('listening…', 'listening')
    if (this.live.usable) {
      this.streaming = true
      this.pendingFrames = [...preRoll]
      void this.live.ensure().then((s) => {
        if (!s) { this.streaming = false; return }
        this.flushFrames()
      })
    } else this.streaming = false
  }

  private onMicFrame(f: Float32Array) {
    if (!this.streaming) return
    this.pendingFrames.push(f)
    if (this.live.isOpen) this.flushFrames()
  }

  private flushFrames() {
    if (!this.live.isOpen || !this.pendingFrames.length) return
    this.live.sendAudio(floatToPcm16Base64(this.pendingFrames))
    this.pendingFrames = []
  }

  private onSpeechEnd(audio?: Float32Array) {
    this.stage.chip.set('')
    this.speechEndAt = performance.now()
    this.firstAudioMs = 0
    if (this.settings.micMode === 'toggle') { this.toggleListening = false; void this.syncMic() }

    if (this.streaming) {
      // Let the mic tail through, then tell the server the stream paused so it answers promptly.
      setTimeout(() => {
        this.flushFrames()
        this.live.endAudio()
        this.streaming = false
      }, 260)
      this.showThinking()
      return
    }
    if (audio && audio.length > 16000 * 0.4) void this.fallbackReply({ audio })
    else this.stage.body.setConv('none')
  }

  private showThinking() {
    clearTimeout(this.thinkingTimer)
    this.thinkingTimer = window.setTimeout(() => {
      if (this.audio.speaking) return
      this.stage.body.setConv('thinking')
      if (!this.stage.bubble.visible || !this.userText) this.stage.bubble.show('', { thinking: true, holdMs: 8000 })
    }, 350)
  }

  // ---------------- Live events ----------------

  private onHerAudio(b64: string, mime: string) {
    if (!this.firstAudioMs && this.speechEndAt) this.firstAudioMs = Math.round(performance.now() - this.speechEndAt)
    clearTimeout(this.thinkingTimer)
    const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000)
    this.audio.enqueuePcm16(b64, rate)
    this.stage.body.setConv('talking')
    this.mic.setHerSpeaking(true)
  }

  private onHerText(delta: string) {
    this.herText += delta
    this.stage.bubble.show(this.herText, { holdMs: 0 })
  }

  private onUserText(delta: string) {
    this.userText += delta
    if (!this.audio.speaking) this.stage.bubble.show(this.userText, { you: true, holdMs: 0 })
  }

  private onTurnComplete() {
    const now = Date.now()
    if (this.userText.trim()) {
      this.memory.turns = mem.addTurn(this.memory.turns, { role: 'user', text: this.userText.trim(), at: now - 1 })
      this.userTurnsSinceDistill++
    }
    if (this.herText.trim()) this.memory.turns = mem.addTurn(this.memory.turns, { role: 'her', text: this.herText.trim(), at: now })
    this.userText = ''
    this.lastInteractionAt = now
    this.saveMemory()
    if (!this.audio.speaking) this.onAudioDrained()
    if (this.userTurnsSinceDistill >= 8) void this.distill()
  }

  private onAudioDrained() {
    this.mic.setHerSpeaking(false)
    if (this.live.busy) return
    this.stage.body.setConv('none')
    if (this.herText) this.stage.bubble.show(this.herText, { holdMs: 4000 })
    this.herText = ''
  }

  private onLiveState(s: LiveState, detail?: string) {
    if (s === 'bad-key' && this.hasKey) {
      // Same key for every Gemini call: stop trying until the user saves a new one.
      this.keyRejected = true
      this.text.setKey('')
      this.local.cloud = null
      this.react('worried', 'shake', 'sweat')
      this.stage.bubble.show('Ehh… Google rejected my key 🥺 Could you check it in Settings? (tray icon → Settings)', { holdMs: 12000 })
      this.bridge.log('warn', `live: bad key ${detail ?? ''}`)
    } else if (s === 'unavailable') {
      this.bridge.log('warn', `live unavailable: ${detail ?? ''}`)
      if (this.stage.body.conv !== 'none' && !this.audio.speaking) this.stage.body.setConv('none')
    }
  }

  // ---------------- speaking without Live ----------------

  /** Text-model reply (typed text, recorded audio, or an event), spoken by the local voice. */
  private async fallbackReply(input: { text?: string; audio?: Float32Array; event?: string }) {
    if (!this.text.usable) {
      if (input.event) return // don't nag with canned lines for every event when offline
      if (this.keyRejected || !this.hasKey) {
        this.react('worried', 'none', 'question')
        this.stage.bubble.show(this.hasKey ? "My key isn't working… fix it in Settings and I'll be all ears!" : 'I need a Gemini key to chat — tray icon → Settings 💗', { holdMs: 6000 })
        this.stage.body.setConv('none')
        return
      }
      this.sayOffline('offline-reply')
      return
    }
    this.stage.body.setConv('thinking')
    this.stage.bubble.show(input.text ?? '', { thinking: true, you: !!input.text, holdMs: 15000 })
    try {
      const msg = input.event ? EVENT_PREFIX + input.event : input.text
      const r = await this.text.reply(this.instruction(), this.memory.turns, { text: msg, audio: input.audio })
      const heard = input.text ?? r.heard
      if (heard && !input.event) {
        this.memory.turns = mem.addTurn(this.memory.turns, { role: 'user', text: heard, at: Date.now() - 1 })
        this.userTurnsSinceDistill++
      }
      if (r.text) {
        this.memory.turns = mem.addTurn(this.memory.turns, { role: 'her', text: r.text, at: Date.now() })
        this.speakLocal(r.text)
      } else this.stage.body.setConv('none')
      this.saveMemory()
      if (this.userTurnsSinceDistill >= 8) void this.distill()
    } catch (err) {
      this.bridge.log('warn', `text brain: ${(err as Error).message}`)
      this.sayOffline('offline-reply')
    }
  }

  private speakLocal(text: string) {
    this.stage.body.setConv('talking')
    this.stage.bubble.show(text, { holdMs: Math.max(4000, text.length * 75) })
    this.mic.setHerSpeaking(true)
    this.local.speak(text)
    // When the system voice or Kokoro finishes, the drain handler resets conv; guard for silent failure.
    window.setTimeout(() => { if (!this.audio.speaking && !this.local.systemSpeaking) { this.stage.body.setConv('none'); this.mic.setHerSpeaking(false) } }, Math.max(6000, text.length * 120))
  }

  private sayOffline(kind: keyof typeof OFFLINE_LINES, speak = true) {
    const l = OFFLINE_LINES[kind]
    const line = pick(l.text)
    this.react(l.emotion, l.action, null)
    if (speak) this.speakLocal(line)
    else {
      this.stage.bubble.show(line, { holdMs: 4500 })
      this.stage.body.setConv('none')
    }
  }

  /** She says something on her own (nudge, timer, welcome back). */
  private async speakEvent(event: string, offline: keyof typeof OFFLINE_LINES) {
    if (this.settings.dnd) return
    this.lastAnyNudgeAt = Date.now()
    if (this.live.usable && (await this.live.sendText(EVENT_PREFIX + event))) {
      this.speechEndAt = performance.now()
      this.firstAudioMs = 0
      return
    }
    if (this.text.usable) return this.fallbackReply({ event })
    this.sayOffline(offline)
  }

  // ---------------- ToolHost ----------------

  react(emotion: Emotion, action: Action, emote: string | null) {
    this.stage.body.setMood(emotion)
    this.stage.face.set(emotion, 7000)
    if (action !== 'none') void this.stage.body.act(action, 3500)
    if (emote) this.stage.emotes.pop(emote)
  }

  startFocus(minutes: number) {
    this.timer.start('focus', minutes)
    this.memory.focus = { ...this.timer.state! }
    this.stage.body.focus = true
    this.saveMemory()
    this.bridge.log('info', `focus started ${minutes}m`)
    return `focus timer started for ${minutes} minutes`
  }

  stopFocus() {
    const was = !!this.timer.state
    this.timer.stop()
    this.memory.focus = null
    this.stage.body.focus = false
    this.stage.chip.set('')
    this.saveMemory()
    return was ? 'timer stopped' : 'no timer was running'
  }

  addGoal(text: string) {
    this.memory.goals = mem.addGoal(this.memory.goals, text)
    this.saveMemory()
    return `added. open goals: ${this.memory.goals.filter((g) => !g.done).map((g) => g.text).join('; ')}`
  }

  completeGoal(which: string) {
    const r = mem.completeGoal(this.memory.goals, which)
    if (!r.done) return 'no matching open goal'
    this.memory.goals = r.goals
    this.saveMemory()
    this.stage.emotes.pop('party')
    void this.stage.body.act('clap')
    const left = r.goals.filter((g) => !g.done).length
    return `marked "${r.done.text}" done. ${left} left today${left === 0 ? ' — all goals done!' : ''}`
  }

  remember(fact: string) {
    this.memory.facts = mem.mergeFacts(this.memory.facts, [fact])
    this.saveMemory()
    return 'saved'
  }

  setUserName(name: string) {
    this.memory.userName = name.trim().slice(0, 40)
    this.saveMemory()
    return `I'll call them ${this.memory.userName}`
  }

  // ---------------- memory ----------------

  private saveMemory() {
    clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.bridge.setMemory(this.memory), 800)
  }

  private async distill() {
    this.userTurnsSinceDistill = 0
    try {
      const r = await this.text.distill(this.memory.turns.slice(-16), this.memory.facts.map((f) => f.text))
      if (r.facts.length) this.memory.facts = mem.mergeFacts(this.memory.facts, r.facts)
      if (r.summary) this.memory.summary = r.summary
      this.saveMemory()
    } catch (err) {
      this.bridge.log('warn', `distill: ${(err as Error).message}`)
    }
  }

  // ---------------- motivation ----------------

  private frame(_dt: number) {
    let level = this.audio.level()
    if (!level && this.local.systemSpeaking) level = 0.35 + Math.sin(performance.now() / 70) * 0.3 * Math.random()
    this.stage.face.mouth = level
    if (this.timer.state && !this.stage.bubble.visible) this.stage.chip.set(this.timer.label())
  }

  private onTimerEnd(kind: 'focus' | 'break', minutes: number) {
    this.memory.focus = null
    this.stage.body.focus = false
    this.stage.chip.set('')
    if (kind === 'focus') {
      this.memory.streak = mem.recordSession(this.memory.streak)
      this.bridge.notify('Focus session done! 🎉', `${minutes} minutes — Manyaki is proud of you. Take a short break~`)
      this.stage.emotes.pop('party')
      void this.stage.body.act('cheer')
      this.timer.start('break', this.settings.breakMinutes)
      this.memory.focus = { ...this.timer.state! }
      const s = this.memory.streak
      void this.speakEvent(`The ${minutes}-minute focus session just finished! That's ${s.sessionsToday} today (${mem.currentStreak(s)}-day streak). Celebrate with them and tell them to take a ${this.settings.breakMinutes}-minute break.`, 'focus-end')
    } else {
      this.bridge.notify('Break over ☕', 'Ready for another round?')
      void this.speakEvent('Their break just ended. Invite them to start another focus session.', 'break-end')
    }
    this.saveMemory()
  }

  private onActivity(a: ActivitySnapshot) {
    const prev = this.activity
    this.activity = a
    this.stage.body.setActivity(a)
    this.stage.setHidden(a.fullscreen)

    const now = Date.now()
    if (!prev || prev.category !== a.category) {
      this.categorySince = now
      if (a.category === 'work' && !this.workStreakSince) this.workStreakSince = now
      if (a.category === 'distraction') this.workStreakSince = null
    }
    // Back after being away for a while: she wakes up happy to see you.
    const idle = a.idleSeconds > 300
    if (this.wasIdle && !idle) {
      const awayMin = Math.round((prev?.idleSeconds ?? 300) / 60)
      this.stage.body.wake()
      this.workStreakSince = null
      if (now - this.lastAnyNudgeAt > 60000) void this.speakEvent(`They just came back to the computer after about ${awayMin} minutes away. Welcome them back.`, 'welcome-back')
    }
    if (idle) this.workStreakSince = null
    this.wasIdle = idle
  }

  private considerNudge() {
    if (!this.memory) return
    const n = decideNudge({
      now: Date.now(),
      dnd: this.settings.dnd,
      talking: this.stage.body.conv !== 'none' || this.audio.speaking,
      lastInteractionAt: this.lastInteractionAt,
      lastNudgeAt: this.lastNudgeAt,
      lastAnyNudgeAt: this.lastAnyNudgeAt,
      focus: this.timer.state,
      category: this.activity?.category ?? null,
      label: this.activity?.label ?? '',
      categorySince: this.categorySince,
      workStreakSince: this.workStreakSince,
      idleSeconds: this.activity?.idleSeconds ?? 0,
      checkInMinutes: this.settings.checkInMinutes,
      openGoals: this.memory.goals.filter((g) => !g.done).length,
      hour: new Date().getHours()
    })
    if (!n) return
    this.lastNudgeAt[n.kind] = Date.now()
    if (n.kind === 'worked-long') this.workStreakSince = Date.now()
    void this.speakEvent(n.event, n.kind)
  }

  // ---------------- interaction ----------------

  private greet() {
    if (!this.hasKey) {
      this.react('happy', 'wave', 'heart')
      this.stage.bubble.show("Hi, I'm Manyaki! 💗 Paste a free Gemini key in Settings so I can talk with you~", { holdMs: 12000 })
      return
    }
    const first = !this.settings.onboarded
    const hour = new Date().getHours()
    const tod = hour < 5 ? 'very late at night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 22 ? 'evening' : 'night'
    if (first) {
      void this.bridge.setSettings({ onboarded: true })
      void this.speakEvent("This is your very first meeting! You just dropped onto their desktop. Introduce yourself in a cute way, say you'll keep them company while they work, and ask their name.", 'hello')
    } else {
      const open = this.memory.goals.filter((g) => !g.done).length
      void this.speakEvent(`They just started their computer; it's ${tod}. Greet them${this.memory.userName ? ` by name` : ''}${open ? ` and mention their ${open} open goal(s)` : ' and ask what they want to get done today'}. Keep it to one or two sentences.`, 'hello')
    }
  }

  private onClick(zone: ClickZone, _n: number) {
    this.lastInteractionAt = Date.now()
    const rapid = this.stage.rapid.length >= 5
    if (rapid) {
      this.stage.rapid = []
      this.react('pout', 'pout', 'anger')
      this.stage.bubble.show('Mou~ stop poking me! 😤', { holdMs: 2500 })
      setTimeout(() => { this.react('happy', 'none', 'heart'); this.stage.bubble.show('…okay, I forgive you. Hehe.', { holdMs: 2500 }) }, 3200)
      return
    }
    if (this.stage.body.conv === 'listening') return
    if (this.audio.speaking) { this.audio.stop(); this.local.stop(); return } // tap to interrupt
    const kind = zone === 'head' ? 'headpat' : 'poke'
    const l = OFFLINE_LINES[kind]
    this.react(l.emotion, l.action, zone === 'head' ? 'heart' : 'sparkle')
    if (zone === 'head') this.stage.face.setBlush(1)
    this.stage.bubble.show(pick(l.text), { holdMs: 2500 })
    setTimeout(() => this.stage.face.setBlush(0), 2500)
  }

  private setupChat() {
    const form = document.getElementById('chat') as HTMLFormElement
    const input = document.getElementById('chat-input') as HTMLInputElement
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const t = input.value.trim()
      input.value = ''
      this.closeChat()
      if (t) void this.sendTyped(t)
    })
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeChat() })
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) this.closeChat() }, 150))
  }

  private openChat() {
    const form = document.getElementById('chat')!
    form.classList.remove('hidden')
    this.bridge.setFocusable(true)
    setTimeout(() => (document.getElementById('chat-input') as HTMLInputElement).focus(), 60)
    this.stage.body.setConv('listening')
  }

  private closeChat() {
    const form = document.getElementById('chat')!
    if (form.classList.contains('hidden')) return
    form.classList.add('hidden')
    this.bridge.setFocusable(false)
    if (this.stage.body.conv === 'listening') this.stage.body.setConv('none')
  }

  private async sendTyped(text: string) {
    this.lastInteractionAt = Date.now()
    this.audio.stop()
    this.local.stop()
    this.stage.bubble.show(text, { you: true, holdMs: 0 })
    this.speechEndAt = performance.now()
    this.firstAudioMs = 0
    if (this.live.usable && (await this.live.sendText(text))) {
      this.userText = text
      this.showThinking()
      return
    }
    await this.fallbackReply({ text })
  }

  private onCommand(c: Command) {
    switch (c.type) {
      case 'toggle-listen':
        if (this.settings.micMode === 'off') { this.openChat(); return }
        if (this.audio.speaking) { this.audio.stop(); this.local.stop() }
        this.toggleListening = !this.toggleListening || this.settings.micMode === 'handsfree'
        this.stage.body.setConv('listening')
        this.stage.chip.set('listening…', 'listening', 6000)
        void this.syncMic().then(() => setTimeout(() => { if (this.stage.body.conv === 'listening' && !this.streaming) this.stage.body.setConv('none') }, 6000))
        break
      case 'focus-start': this.startFocus(c.minutes ?? this.settings.focusMinutes); this.sayFocusStart(); break
      case 'focus-stop': this.stopFocus(); this.react('relaxed', 'nod', null); break
      case 'corner': this.stage.body.goCorner(); break
      case 'say-hi': this.react('happy', 'wave', 'heart'); break
      case 'chat': this.openChat(); break
      case 'reload-key': void this.loadKey().then(() => { if (this.hasKey) this.greet() }); break
    }
  }

  private sayFocusStart() {
    void this.speakEvent(`They just started a ${this.settings.focusMinutes}-minute focus session from the tray. Cheer them on in one short sentence; you'll stay quiet and watch.`, 'focus-start')
  }

  private onLanded(hard: boolean) {
    if (hard) {
      this.react('pout', 'none', 'sweat')
      this.stage.bubble.show(pick(['Owww… be gentle!', 'Hey! I\'m not a toy~', 'Wahh, dizzy…']), { holdMs: 2500 })
    } else if (Math.random() < 0.3) this.stage.emotes.pop('sparkle')
  }

  // ---------------- debug ----------------

  debugActions() {
    return [
      { label: 'greet', run: () => this.greet() },
      { label: 'say via live', run: () => void this.speakEvent('The developer pressed a test button. Say something cute and short.', 'check-in') },
      { label: 'focus 10s', run: () => { this.timer.start('focus', 10 / 60); this.stage.body.focus = true } },
      { label: 'nudge now', run: () => { this.lastAnyNudgeAt = 0; this.lastInteractionAt = 0; this.considerNudge() } },
      { label: 'offline line', run: () => this.sayOffline('check-in') },
      { label: 'local voice', run: () => this.speakLocal('Hi! This is my backup voice. Can you hear me?') },
      { label: 'distill', run: () => void this.distill() },
      { label: 'chat', run: () => this.openChat() }
    ]
  }

  debugStats() {
    return [
      `live ${this.live.state} (connect ${this.live.connectMs}ms) ${this.live.lastError.slice(0, 60)}`,
      `speech→audio ${this.firstAudioMs}ms  kokoro ${this.local.isReady ? 'ready' : Math.round(this.local.progress * 100) + '%'} (${Math.round(this.local.lastMs)}ms)`,
      `mic ${this.mic.enabled ? 'on' : 'off'} ${this.micError}`,
      `activity ${this.activity?.label ?? '-'} ${this.activity?.category ?? ''} idle ${this.activity?.idleSeconds ?? 0}s`,
      `timer ${this.timer.label() || '-'}  facts ${this.memory?.facts.length ?? 0}  turns ${this.memory?.turns.length ?? 0}`
    ].join('\n')
  }
}
