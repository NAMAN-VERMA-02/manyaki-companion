import { app, shell } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

// Things Manyaki may do on the computer when asked. Deliberately limited to *opening* things:
// folders, installed apps (via their Start-menu shortcuts) and https websites. No shell commands,
// no file changes, nothing destructive.

export type ActionKind = 'folder' | 'app' | 'website'
export interface ActionResult { ok: boolean; opened?: string; error?: string }

import { matchScore, norm, resolveWebsite } from './resolve'

// ---------- folders ----------

const SKIP_DIRS = /^(node_modules|\.git|\.cache|appdata|\$recycle\.bin|windows|program files.*|programdata|\..+)$/i

function knownFolder(key: string): string | null {
  const h = homedir()
  const map: Record<string, string> = {
    desktop: app.getPath('desktop'), documents: app.getPath('documents'), docs: app.getPath('documents'),
    downloads: app.getPath('downloads'), download: app.getPath('downloads'), pictures: app.getPath('pictures'),
    photos: app.getPath('pictures'), music: app.getPath('music'), videos: app.getPath('videos'),
    home: h, 'user folder': h
  }
  return map[key] ?? null
}

/** Breadth-first search for a folder by name under the usual places (depth-limited, skips noise). */
function findFolder(query: string): string | null {
  const roots = [app.getPath('desktop'), app.getPath('documents'), app.getPath('downloads'), homedir()]
  // OneDrive often holds the real Desktop/Documents.
  const od = join(homedir(), 'OneDrive')
  if (existsSync(od)) roots.unshift(join(od, 'Desktop'), join(od, 'Documents'))
  let best: { path: string; score: number; depth: number } | null = null
  const seen = new Set<string>()
  const queue: { dir: string; depth: number }[] = roots.filter(existsSync).map((dir) => ({ dir, depth: 0 }))
  let visited = 0
  while (queue.length && visited < 4000) {
    const { dir, depth } = queue.shift()!
    if (seen.has(dir.toLowerCase())) continue
    seen.add(dir.toLowerCase())
    visited++
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (SKIP_DIRS.test(name)) continue
      const full = join(dir, name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { continue }
      if (!isDir) continue
      const score = matchScore(query, name)
      if (score >= 40 && (!best || score > best.score || (score === best.score && depth < best.depth))) best = { path: full, score, depth }
      if (depth < 3) queue.push({ dir: full, depth: depth + 1 })
    }
    if (best?.score === 100 && best.depth === 0) break
  }
  return best?.path ?? null
}

// ---------- apps ----------

const BUILTIN_APPS: Record<string, string> = {
  notepad: 'notepad.exe', calculator: 'calc.exe', calc: 'calc.exe', paint: 'mspaint.exe',
  explorer: 'explorer.exe', 'file explorer': 'explorer.exe', files: 'explorer.exe',
  settings: 'ms-settings:', 'task manager': 'taskmgr.exe', camera: 'microsoft.windows.camera:',
  clock: 'ms-clock:', alarms: 'ms-clock:', 'snipping tool': 'ms-screenclip:', store: 'ms-windows-store:'
}

function startMenuShortcuts(): string[] {
  const dirs = [
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    app.getPath('desktop')
  ]
  const out: string[] = []
  const walk = (d: string, depth: number) => {
    let entries: string[] = []
    try { entries = readdirSync(d) } catch { return }
    for (const n of entries) {
      const f = join(d, n)
      const ext = extname(n).toLowerCase()
      if (ext === '.lnk' || ext === '.url' || ext === '.appref-ms') out.push(f)
      else if (depth < 3) { try { if (statSync(f).isDirectory()) walk(f, depth + 1) } catch { /* ignore */ } }
    }
  }
  for (const d of dirs) walk(d, 0)
  return out
}

const APP_ALIASES: Record<string, string> = {
  'vs code': 'visual studio code', vscode: 'visual studio code', code: 'visual studio code',
  chrome: 'google chrome', edge: 'microsoft edge', word: 'word', excel: 'excel', powerpoint: 'powerpoint', ppt: 'powerpoint',
  terminal: 'terminal', 'android studio': 'android studio', whatsapp: 'whatsapp', spotify: 'spotify', discord: 'discord'
}

function findApp(query: string): string | null {
  const q = APP_ALIASES[norm(query)] ?? query
  let best: { path: string; score: number } | null = null
  for (const f of startMenuShortcuts()) {
    const name = basename(f, extname(f))
    if (/uninstall|readme|help|documentation|website/i.test(name)) continue
    const score = matchScore(q, name)
    if (score >= 40 && (!best || score > best.score)) best = { path: f, score }
  }
  return best?.path ?? null
}

// ---------- entry point ----------

export async function runAction(kind: ActionKind, target: string): Promise<ActionResult> {
  const t = String(target ?? '').trim().slice(0, 200)
  if (!t) return { ok: false, error: 'nothing to open' }
  try {
    if (kind === 'website') {
      const url = resolveWebsite(t)
      await shell.openExternal(url)
      return { ok: true, opened: url }
    }
    if (kind === 'folder') {
      const path = knownFolder(norm(t)) ?? (existsSync(t) && statSync(t).isDirectory() ? t : null) ?? findFolder(t)
      if (!path) return { ok: false, error: `couldn't find a folder called "${t}"` }
      const err = await shell.openPath(path)
      return err ? { ok: false, error: err } : { ok: true, opened: path }
    }
    if (kind === 'app') {
      const builtin = BUILTIN_APPS[norm(t)]
      if (builtin) {
        if (builtin.endsWith(':')) await shell.openExternal(builtin)
        else {
          const root = process.env.SystemRoot ?? 'C:\\Windows'
          const exe = [join(root, 'System32', builtin), join(root, builtin)].find(existsSync) ?? builtin
          const err = await shell.openPath(exe)
          if (err) return { ok: false, error: err }
        }
        return { ok: true, opened: t }
      }
      const lnk = findApp(t)
      if (!lnk) return { ok: false, error: `couldn't find an app called "${t}" in the Start menu` }
      const err = await shell.openPath(lnk)
      return err ? { ok: false, error: err } : { ok: true, opened: basename(lnk, extname(lnk)) }
    }
    return { ok: false, error: 'unknown action' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
