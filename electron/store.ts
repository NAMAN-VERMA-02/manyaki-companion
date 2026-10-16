import Store from 'electron-store'
import { safeStorage } from 'electron'
import { DEFAULT_SETTINGS, EMPTY_MEMORY, type MemoryData, type Settings } from '../shared/types'

interface Schema {
  settings: Settings
  memory: MemoryData
  apiKeyEnc: string
}

const store = new Store<Schema>({
  name: 'manyaki',
  defaults: { settings: DEFAULT_SETTINGS, memory: EMPTY_MEMORY, apiKeyEnc: '' }
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

export function getMemory(): MemoryData {
  return migrateMemory(store.get('memory'))
}

export function setMemory(m: MemoryData): void {
  store.set('memory', migrateMemory(m))
}

export function wipeMemory(): void {
  store.set('memory', EMPTY_MEMORY)
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
