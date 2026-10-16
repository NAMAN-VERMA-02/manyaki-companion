import type { Bridge, MemoryData, Settings, Status } from '../../shared/types'

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
  surprised: 'surprised 😮', relaxed: 'relaxed 😌', shy: 'shy ☺️', smug: 'smug 😏', sleepy: 'sleepy 😪', neutral: 'calm 🙂'
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
  bridge.on('status', (s) => { status = s; renderStatus(); renderTimer() })
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
