import type { Bridge, EyesInfo, MemoryData, Settings, Status } from '../../shared/types'

// The Home tab: her live status, quick controls, focus timer, chat and today's goals.

const bridge = (window as unknown as { manyaki: Bridge }).manyaki
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let status: Status | null = null
let settings: Settings | null = null
let memory: MemoryData | null = null

export function showTab(tab: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tab')) b.classList.toggle('active', b.dataset.tab === tab)
  $('home').classList.toggle('hidden', tab !== 'home')
  $('settings').classList.toggle('hidden', tab !== 'settings')
}

const MOODS: Record<string, string> = {
  happy: 'happy 😊', excited: 'excited ✨', sad: 'a bit sad 🥺', worried: 'worried 😟', angry: 'grumpy 😤', pout: 'pouting 😤',
  surprised: 'surprised 😮', relaxed: 'relaxed 😌', shy: 'shy ☺️', smug: 'smug 😏', sleepy: 'sleepy 😪', neutral: 'calm 🙂',
  proud: 'proud 🌟', love: 'full of love 💗', grateful: 'grateful 🙏', playful: 'playful 😜', curious: 'curious 🤔',
  determined: 'determined 🔥', confused: 'confused 😵', embarrassed: 'embarrassed 😳', nervous: 'nervous 😬', scared: 'scared 😨',
  lonely: 'lonely 🥺', disappointed: 'disappointed 😞', hurt: 'hurt 💔', cry: 'teary 😢', jealous: 'jealous 😒', grumpy: 'grumpy 😾', bored: 'bored 🥱'
}
const DOING: Record<string, string> = {
  stand: 'hanging out', walk: 'walking around', sit: 'sitting', sleep: 'napping 💤', act: 'busy', fall: 'falling!',
  jump: 'jumping', drag: 'being carried', land: 'landing'
}
const BRAIN: Record<Status['brain'], string> = {
  live: '🧠 Live voice ready', connecting: '🧠 connecting…', fallback: '🧠 backup brain', local: '🧠 local brain (offline)', 'no-key': '🧠 needs a key',
  'bad-key': '🧠 key rejected', offline: '🧠 offline'
}

function renderStatus() {
  const s = status
  if (!s) return
  const doing = s.conv === 'talking' ? 'talking to you' : s.conv === 'listening' ? 'listening to you' : s.conv === 'thinking' ? 'thinking…' : DOING[s.mode] ?? s.mode
  $('status-line').textContent = s.hidden ? 'hiding for now 🙈' : `${doing} · feeling ${MOODS[s.mood] ?? s.mood}`
  $('chip-brain').textContent = BRAIN[s.brain]
  $('chip-brain').className = `chip ${s.brain === 'live' ? 'ok' : s.brain === 'connecting' || s.brain === 'fallback' ? '' : 'bad'}`
  $('chip-mic').textContent = s.mic === 'on' ? '🎤 listening' : s.mic === 'blocked' ? '🎤 blocked by Windows' : '🎤 off (typing)'
  $('chip-mic').className = `chip ${s.mic === 'blocked' ? 'bad' : s.mic === 'on' ? 'ok' : ''}`
  $('chip-place').textContent = s.activity ? `📍 you're in ${s.activity}` : '📍 —'
  $('last-line').textContent = s.lastLine ? `“${s.lastLine}”` : ''
  $('q-hide').textContent = s.hidden ? '🙋 Show her' : '🙈 Hide 30 min'
}

function renderHeart() {
  const h = status?.heart
  if (!h) return
  $('h-bond').style.width = `${Math.round(h.bond)}%`
  $('h-bond-label').textContent = `${h.bondLabel} · ${Math.round(h.bond)}`
  // Pleasure -1..1 shown as 0..100%.
  $('h-mood').style.width = `${Math.round((h.pleasure + 1) * 50)}%`
  $('h-feeling').textContent = MOODS[h.feeling] ?? h.feeling
  $('h-energy').style.width = `${Math.round(h.energy * 100)}%`
  $('h-energy-label').textContent = h.energy < 0.25 ? 'very sleepy 😪' : h.energy < 0.45 ? 'a bit tired' : h.energy > 0.75 ? 'full of energy ⚡' : 'awake'
  const parts = []
  if (h.youSeem) parts.push(`You seem ${h.youSeem} right now.`)
  if (h.trend) parts.push(`This week you've seemed ${h.trend}.`)
  $('h-you').textContent = parts.join(' ')
}

let eyes: EyesInfo | null = null
async function refreshEyes() {
  eyes = await bridge.eyes.info().catch(() => null)
  const e = eyes
  if (!e) return
  $('eyes-server').textContent = e.running ? `server on :${e.port}` : `server off${e.error ? ` (${e.error})` : ''}`
  $('eyes-server').className = `chip ${e.running ? 'ok' : 'bad'}`
  const connected = e.connected || !!status?.eyes?.connected
  $('eyes-ext').textContent = connected ? 'extension connected' : 'extension not connected'
  $('eyes-ext').className = `chip ${connected ? 'ok' : ''}`
  $('eyes-planner').textContent = `planner: ${e.planner}`
  $('eyes-code').textContent = e.pairing || '—'
  const t = status?.eyes
  $('eyes-last').textContent = t?.task ? `Last task: “${t.task}”${t.redactions ? ` · hid ${t.redactions} private item${t.redactions === 1 ? '' : 's'}` : ''}${t.step ? ` · ${t.step}` : ''}` : ''
}

function renderTimer() {
  const t = status?.timer
  if (!t) {
    $('timer').textContent = '--:--'
    $('timer-label').textContent = 'Not running'
    $('timer').className = 'timer'
    return
  }
  const ms = Math.max(0, t.endsAt - Date.now())
  $('timer').textContent = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
  $('timer-label').textContent = t.kind === 'focus' ? `🎯 Focus — ${t.minutes} min session` : '☕ Break time'
  $('timer').className = `timer ${t.kind}`
}

function renderSettings() {
  const s = settings
  if (!s) return
  $<HTMLSelectElement>('q-mic').value = s.micMode
  $<HTMLSelectElement>('q-size').value = String(s.size)
  $('q-mute').textContent = s.voiceMuted ? '🔇 Voice muted' : '🔊 Voice on'
  $('q-mute').classList.toggle('on', s.voiceMuted)
  $('q-dnd').classList.toggle('on', s.dnd)
  $('q-dnd').textContent = s.dnd ? '🌙 Do not disturb: on' : '🌙 Do not disturb'
  $('chip-voice').textContent = s.voiceMuted ? '🔇 voice muted' : '🔊 voice on'
  $('q-stream').classList.toggle('on', s.streamSafe)
  $('q-stream').textContent = s.streamSafe ? '🎥 Stream-safe: on' : '🎥 Stream-safe'
  $('q-private').classList.toggle('on', s.brainMode === 'private')
  $('q-private').textContent = s.brainMode === 'private' ? '🔒 Private: on' : '🔒 Private mode'
  $('q-attach').classList.toggle('on', s.emotionalAttachment)
  $('q-attach').textContent = s.emotionalAttachment ? '💞 Emotional attachment: on' : '💼 Professional (attachment off)'
  if (document.activeElement !== $('focus-min')) $<HTMLInputElement>('focus-min').value = String(s.focusMinutes)
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function editMemory(fn: (m: MemoryData) => void) {
  const cur = await bridge.getMemory()
  fn(cur)
  await bridge.setMemory(cur)
  memory = cur
  renderMemory()
}

function renderMemory() {
  const m = memory
  if (!m) return
  const tr = $('transcript')
  const atBottom = tr.scrollHeight - tr.scrollTop - tr.clientHeight < 40
  tr.innerHTML = ''
  if (!m.turns.length) tr.innerHTML = '<p class="hint">No messages yet — say hi! 💗</p>'
  for (const t of m.turns.slice(-40)) {
    const d = document.createElement('div')
    d.className = `msg ${t.role}`
    d.textContent = t.text
    tr.append(d)
  }
  if (atBottom) tr.scrollTop = tr.scrollHeight

  const ul = $('home-goals')
  ul.innerHTML = ''
  if (!m.goals.length) ul.innerHTML = '<li class="hint">No goals yet. Add one, or tell her what you want to get done.</li>'
  for (const g of m.goals) {
    const li = document.createElement('li')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = g.done
    cb.onchange = () => {
      void editMemory((cur) => { const x = cur.goals.find((y) => y.id === g.id); if (x) x.done = cb.checked })
      if (cb.checked) bridge.sendCommand({ type: 'say', text: `(I just ticked off my goal "${g.text}"!)` })
    }
    const span = document.createElement('span')
    span.textContent = g.text
    if (g.done) span.className = 'done'
    const x = document.createElement('button')
    x.textContent = '✕'
    x.className = 'link'
    x.title = 'Remove'
    x.onclick = () => void editMemory((cur) => { cur.goals = cur.goals.filter((y) => y.id !== g.id) })
    li.append(cb, span, x)
    ul.append(li)
  }
  const st = m.streak
  $('streak').textContent = st.sessionsTotal ? `🔥 ${st.days}-day streak · ${st.sessionsToday} session(s) today · ${st.sessionsTotal} total` : ''
}

async function save(patch: Partial<Settings>) {
  settings = await bridge.setSettings(patch)
  renderSettings()
}

export async function initHome() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tab')) b.onclick = () => showTab(b.dataset.tab!)
  bridge.on('tab', (t) => showTab(t))
  settings = await bridge.getSettings()
  memory = await bridge.getMemory()
  renderSettings()
  renderMemory()
  bridge.on('status', (s) => { status = s; renderStatus(); renderTimer(); renderHeart() })
  bridge.on('eyes', () => void refreshEyes())
  void refreshEyes()
  setInterval(() => void refreshEyes(), 5000)
  $('eyes-copy').onclick = async () => {
    if (!eyes?.pairing) return
    await navigator.clipboard.writeText(eyes.pairing)
    $('eyes-copy').textContent = 'Copied ✓'
    setTimeout(() => ($('eyes-copy').textContent = 'Copy'), 1500)
  }
  $('eyes-folder').onclick = async () => {
    const r = await bridge.eyes.openExtensionFolder()
    if (/not built/.test(r)) alert(`The extension isn't built yet. In the project folder run: npm run eyes:build`)
  }
  $('eyes-new').onclick = async () => {
    if (!confirm('Make a new pairing code? The browser extension will need the new one.')) return
    eyes = await bridge.eyes.newPairing()
    void refreshEyes()
  }
  bridge.on('settings', (s) => { settings = s; renderSettings() })
  bridge.on('memory', (m) => { memory = m; renderMemory() })
  setInterval(renderTimer, 500)
  // Her side saves memory with a short debounce; refresh the transcript lightly as a safety net.
  setInterval(async () => { memory = await bridge.getMemory(); renderMemory() }, 4000)

  $<HTMLSelectElement>('q-mic').onchange = (e) => void save({ micMode: (e.target as HTMLSelectElement).value as Settings['micMode'] })
  $<HTMLSelectElement>('q-size').onchange = (e) => void save({ size: Number((e.target as HTMLSelectElement).value) })
  $('q-mute').onclick = () => void save({ voiceMuted: !settings?.voiceMuted })
  $('q-dnd').onclick = () => void save({ dnd: !settings?.dnd })
  $('q-hide').onclick = () => bridge.sendCommand(status?.hidden ? { type: 'show' } : { type: 'hide', minutes: 30 })
  $('q-here').onclick = () => bridge.sendCommand({ type: 'come-here' })
  $('q-corner').onclick = () => bridge.sendCommand({ type: 'corner' })
  $('q-hi').onclick = () => bridge.sendCommand({ type: 'say-hi' })
  $('q-reset').onclick = () => bridge.sendCommand({ type: 'reset' })
  $('q-look').onclick = () => bridge.sendCommand({ type: 'look' })
  $('q-stream').onclick = () => void save({ streamSafe: !settings?.streamSafe })
  $('q-attach').onclick = () => void save({ emotionalAttachment: !settings?.emotionalAttachment })
  $('q-private').onclick = () => void save({ brainMode: settings?.brainMode === 'private' ? 'auto' : 'private' })
  $('focus-start').onclick = () => {
    const m = Math.max(1, Math.min(120, Math.round(Number($<HTMLInputElement>('focus-min').value) || 25)))
    bridge.sendCommand({ type: 'focus-start', minutes: m })
  }
  $('focus-stop').onclick = () => bridge.sendCommand({ type: 'focus-stop' })
  $('chat-form').onsubmit = (e) => {
    e.preventDefault()
    const input = $<HTMLInputElement>('chat-text')
    const t = input.value.trim()
    if (!t) return
    input.value = ''
    bridge.sendCommand({ type: 'say', text: t })
    const d = document.createElement('div')
    d.className = 'msg user pending'
    d.textContent = t
    $('transcript').append(d)
    $('transcript').scrollTop = $('transcript').scrollHeight
  }
  $('goal-form').onsubmit = (e) => {
    e.preventDefault()
    const input = $<HTMLInputElement>('goal-text')
    const t = input.value.trim()
    if (!t) return
    input.value = ''
    void editMemory((cur) => { cur.goals.push({ id: Math.random().toString(36).slice(2, 9), text: t, done: false, day: today() }) })
  }
  $('quit').onclick = () => { if (confirm('Quit Manyaki? She will leave your desktop until you start her again.')) bridge.quit() }
}
