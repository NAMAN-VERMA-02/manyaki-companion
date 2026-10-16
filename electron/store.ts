import Store from 'electron-store'
import { safeStorage } from 'electron'
import { DEFAULT_SETTINGS, EMPTY_MEMORY, type MemoryData, type Settings } from '../shared/types'

interface Schema {
  settings: Settings
  /** Legacy plain-text memory; migrated into memoryEnc on first read. */
  memory: MemoryData | null
  /** Memory (name, facts, goals, chat history) encrypted with Windows DPAPI via safeStorage. */
  memoryEnc: string
  apiKeyEnc: string
}

const store = new Store<Schema>({
  name: 'manyaki',
  defaults: { settings: DEFAULT_SETTINGS, memory: null, memoryEnc: '', apiKeyEnc: '' }
})

export function getSettings(): Settings {
  const s = store.get('settings')
  // Merge so settings added in newer versions get their defaults.
  return { ...DEFAULT_SETTINGS, ...s, categoryRules: { ...DEFAULT_SETTINGS.categoryRules, ...s.categoryRules } }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  store.set('settings', next)
  return next
}

let memoryCache: MemoryData | null = null

export function getMemory(): MemoryData {
  if (memoryCache) return structuredClone(memoryCache)
  let m: MemoryData | null = null
  const enc = store.get('memoryEnc')
  if (enc && safeStorage.isEncryptionAvailable()) {
    try { m = JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))) } catch { m = null }
  }
  if (!m) {
    // First run after the upgrade: move the old plain-text memory into encrypted storage.
    const legacy = store.get('memory')
    m = migrateMemory(legacy ?? undefined)
    if (legacy) { writeMemory(m); store.set('memory', null) }
  }
  memoryCache = migrateMemory(m)
  return structuredClone(memoryCache)
}

function writeMemory(m: MemoryData) {
  if (safeStorage.isEncryptionAvailable()) {
    store.set('memoryEnc', safeStorage.encryptString(JSON.stringify(m)).toString('base64'))
    store.set('memory', null)
  } else store.set('memory', m) // no OS keychain available: fall back to plain storage
}

export function setMemory(m: MemoryData): void {
  memoryCache = migrateMemory(m)
  writeMemory(memoryCache)
}

export function wipeMemory(): void {
  memoryCache = structuredClone(EMPTY_MEMORY)
  writeMemory(memoryCache)
}

export function migrateMemory(m: Partial<MemoryData> | undefined): MemoryData {
  const base = structuredClone(EMPTY_MEMORY)
  if (!m || typeof m !== 'object') return base
  return {
    ...base,
    ...m,
    version: EMPTY_MEMORY.version,
    facts: Array.isArray(m.facts) ? m.facts.slice(-50) : [],
    goals: Array.isArray(m.goals) ? m.goals : [],
    turns: Array.isArray(m.turns) ? m.turns.slice(-40) : [],
    streak: { ...base.streak, ...(m.streak ?? {}) }
  }
}

// The Gemini key is encrypted with Windows DPAPI via safeStorage and never stored in plain text.
export function getApiKey(): string {
  const enc = store.get('apiKeyEnc')
  if (!enc) return ''
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : ''
  } catch {
    return ''
  }
}

export function setApiKey(key: string): boolean {
  const trimmed = key.trim()
  if (!trimmed) {
    store.set('apiKeyEnc', '')
    return true
  }
  if (!safeStorage.isEncryptionAvailable()) return false
  store.set('apiKeyEnc', safeStorage.encryptString(trimmed).toString('base64'))
  return true
}

export const storePath = (): string => store.path
