import type { Bridge, MemoryData, Settings } from '../../shared/types'

const bridge = (window as unknown as { manyaki: Bridge }).manyaki
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let savedTimer = 0

function flashSaved(text = 'Saved ✓') {
  const el = $('saved')
  el.textContent = text
  clearTimeout(savedTimer)
  savedTimer = window.setTimeout(() => (el.textContent = ''), 1800)
}

async function save(patch: Partial<Settings>) {
  await bridge.setSettings(patch)
  flashSaved()
}

function fill(s: Settings) {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=mic]')) r.checked = r.value === s.micMode
  $<HTMLSelectElement>('voice').value = s.voiceName
  $<HTMLSelectElement>('size').value = String(s.size)
  $<HTMLInputElement>('focus').value = String(s.focusMinutes)
  $<HTMLInputElement>('break').value = String(s.breakMinutes)
  $<HTMLInputElement>('checkin').value = String(s.checkInMinutes)
  $<HTMLInputElement>('launch').checked = s.launchAtLogin
  $<HTMLInputElement>('dnd').checked = s.dnd
  $<HTMLInputElement>('neural').checked = s.neuralVoice
  $<HTMLInputElement>('titles').checked = s.shareTitles
  $<HTMLTextAreaElement>('work').value = s.categoryRules.work.join(', ')
  $<HTMLTextAreaElement>('distraction').value = s.categoryRules.distraction.join(', ')
}

function renderMemory(m: MemoryData) {
  $('mem-summary').textContent = `${m.userName ? `Name: ${m.userName}. ` : ''}${m.streak.sessionsTotal} focus sessions total, ${m.streak.days}-day streak.${m.summary ? ` Last chat: ${m.summary}` : ''}`
  const facts = $('facts')
  facts.innerHTML = ''
  for (const [i, f] of m.facts.entries()) {
    const li = document.createElement('li')
    li.textContent = f.text
    const x = document.createElement('button')
    x.textContent = '✕'
    x.title = 'Forget this'
    x.onclick = async () => {
      const cur = await bridge.getMemory()
      cur.facts.splice(i, 1)
      await bridge.setMemory(cur)
      renderMemory(cur)
    }
    li.append(x)
    facts.append(li)
  }
  if (!m.facts.length) facts.innerHTML = '<li class="hint">Nothing yet — talk to her!</li>'
  const goals = $('goals')
  goals.innerHTML = ''
  for (const g of m.goals) {
    const li = document.createElement('li')
    li.textContent = `${g.done ? '✅' : '⬜'} ${g.text}`
    goals.append(li)
  }
}

async function refreshKey() {
  const has = await bridge.hasApiKey()
  $('key-status').textContent = has ? '✓ Key saved. She can talk!' : 'No key yet.'
  $('key-section').classList.toggle('done', has)
}

async function init() {
  fill(await bridge.getSettings())
  renderMemory(await bridge.getMemory())
  await refreshKey()

  $('save-key').onclick = async () => {
    const input = $<HTMLInputElement>('key')
    const v = input.value.trim()
    if (!v) return
    // Key formats change over time; only reject things that clearly aren't a key (spaces, too short).
    if (v.length < 20 || /\s/.test(v)) {
      $('key-status').textContent = "That doesn't look like a complete Gemini key — copy it again from AI Studio."
      return
    }
    const ok = await bridge.setApiKey(v)
    input.value = ''
    if (!ok) $('key-status').textContent = 'Could not store the key securely on this PC.'
    else { await refreshKey(); flashSaved('Key saved ✓') }
  }

  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=mic]')) r.onchange = () => save({ micMode: r.value as Settings['micMode'] })
  $<HTMLSelectElement>('voice').onchange = (e) => save({ voiceName: (e.target as HTMLSelectElement).value })
  $<HTMLSelectElement>('size').onchange = (e) => save({ size: Number((e.target as HTMLSelectElement).value) })
  const num = (id: string, key: 'focusMinutes' | 'breakMinutes' | 'checkInMinutes', min: number, max: number) => {
    $<HTMLInputElement>(id).onchange = (e) => {
      const v = Math.max(min, Math.min(max, Math.round(Number((e.target as HTMLInputElement).value) || min)))
      ;(e.target as HTMLInputElement).value = String(v)
      void save({ [key]: v } as Partial<Settings>)
    }
  }
  num('focus', 'focusMinutes', 5, 120)
  num('break', 'breakMinutes', 1, 60)
  num('checkin', 'checkInMinutes', 5, 120)
  $<HTMLInputElement>('launch').onchange = (e) => save({ launchAtLogin: (e.target as HTMLInputElement).checked })
  $<HTMLInputElement>('dnd').onchange = (e) => save({ dnd: (e.target as HTMLInputElement).checked })
  $<HTMLInputElement>('neural').onchange = (e) => save({ neuralVoice: (e.target as HTMLInputElement).checked })
  $<HTMLInputElement>('titles').onchange = (e) => save({ shareTitles: (e.target as HTMLInputElement).checked })
  const rules = () => {
    const split = (id: string) => $<HTMLTextAreaElement>(id).value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    void save({ categoryRules: { work: split('work'), distraction: split('distraction') } })
  }
  $('work').onchange = rules
  $('distraction').onchange = rules

  $('export').onclick = async () => {
    const p = await bridge.exportMemory()
    if (p) flashSaved('Exported ✓')
  }
  $('wipe').onclick = async () => {
    if (!confirm('Make Manyaki forget everything about you (name, facts, goals, streaks)? This cannot be undone.')) return
    await bridge.wipeMemory()
    renderMemory(await bridge.getMemory())
    flashSaved('Forgotten')
  }

  bridge.on('settings', fill)
  // Never show a stale key status: re-check whenever the window is focused.
  window.addEventListener('focus', () => void refreshKey())
  bridge.on('memory', renderMemory)
}

void init()
