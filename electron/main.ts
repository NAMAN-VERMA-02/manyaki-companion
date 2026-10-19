import { fork, type ChildProcess } from 'node:child_process'
import { app, desktopCapturer, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, protocol, screen, session, shell, Tray } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Command, DisplayInfo, Settings } from '../shared/types'
import { startActivityWatcher } from './activity'
import * as store from './store'
import { runAction, type ActionKind } from './actions'
import { eyesInfo, eyesTask, newPairingCode, setEyesProvider, startEyes, stopEyes } from './eyes'
import * as desk from './desk'
import type { ActivitySnapshot, WindowOp } from '../shared/types'

// ---------- offline brain (utility process) ----------
let brain: ChildProcess | null = null
let brainSeq = 0
const brainPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let brainStatus: unknown = null

function startBrain() {
  if (brain) return brain
  // A normal child process running Electron's bundled Node (no separate Node install needed).
  brain = fork(join(__dirname, 'localbrain.js'), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MANYAKI_MODELS_DIR: join(app.getPath('userData'), 'models') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced', // typed arrays (audio) cross the boundary without JSON copies
    windowsHide: true
  })
  brain.stderr?.on('data', (d) => log('warn', `brain: ${String(d).trim().slice(0, 300)}`))
  brain.on('message', (raw) => {
    const m = raw as { id?: number; ok?: boolean; result?: unknown; error?: string; type?: string; status?: unknown }
    if (m.type === 'status') {
      brainStatus = m.status
      send('local-status', m.status)
      return
    }
    const p = m.id != null ? brainPending.get(m.id) : undefined
    if (!p) return
    brainPending.delete(m.id!)
    if (m.ok) p.resolve(m.result)
    else p.reject(new Error(m.error ?? 'local brain error'))
  })
  brain.on('exit', (code) => {
    log('warn', `local brain exited (${code})`)
    brain = null
    for (const p of brainPending.values()) p.reject(new Error('local brain stopped'))
    brainPending.clear()
  })
  return brain
}

function askBrain(msg: Record<string, unknown>, timeoutMs = 120000): Promise<unknown> {
  const b = startBrain()
  const id = ++brainSeq
  return new Promise((resolve, reject) => {
    brainPending.set(id, { resolve, reject })
    b.send({ ...msg, id })
    setTimeout(() => { if (brainPending.delete(id)) reject(new Error('local brain timed out')) }, timeoutMs)
  })
}

const DEBUG = process.argv.includes('--manyaki-debug') || !!process.env.MANYAKI_DEBUG
const ASSET_SCHEME = 'manyaki-asset'

protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

if (!app.requestSingleInstanceLock()) app.quit()

let overlay: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let tray: Tray | null = null
let stopActivity: (() => void) | null = null

const assetsRoot = () => (app.isPackaged ? join(process.resourcesPath, 'assets') : join(app.getAppPath(), 'assets'))
const userAnimsDir = () => join(app.getPath('userData'), 'anims')
const logFile = () => join(app.getPath('userData'), 'manyaki.log')

function log(level: string, msg: string) {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`
  if (DEBUG || level !== 'info') process.stdout.write(line)
  try { appendFileSync(logFile(), line) } catch { /* ignore */ }
}

function displayInfo(): DisplayInfo {
  const d = screen.getPrimaryDisplay()
  return { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor }
}

function rendererUrl(page: 'index' | 'settings'): { url?: string; file?: string } {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) return { url: `${dev}/${page}.html` }
  return { file: join(__dirname, `../renderer/${page}.html`) }
}

function load(win: BrowserWindow, page: 'index' | 'settings') {
  const target = rendererUrl(page)
  const args = DEBUG ? { query: { debug: '1' } } : undefined
  if (target.url) void win.loadURL(target.url + (DEBUG ? '?debug=1' : ''))
  else void win.loadFile(target.file!, args)
}

function createOverlay() {
  const { bounds, workArea } = displayInfo()
  // Normally a small window that the renderer moves along with her (transparent windows on Windows cost
  // CPU proportional to their area every frame). In debug mode it covers the display for the debug panel.
  const initial = DEBUG ? bounds : { x: workArea.x + workArea.width - 420, y: workArea.y + workArea.height - 480, width: 400, height: 480 }
  overlay = new BrowserWindow({
    ...initial,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'Manyaki',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
      additionalArguments: DEBUG ? ['--manyaki-debug'] : []
    }
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true)
  overlay.setIgnoreMouseEvents(true, { forward: true })
  load(overlay, 'index')
  overlay.once('ready-to-show', () => overlay?.showInactive())

  overlay.webContents.on('render-process-gone', (_e, details) => {
    log('error', `renderer gone: ${details.reason}; reloading`)
    setTimeout(() => overlay && !overlay.isDestroyed() && load(overlay, 'index'), 1000)
  })
  overlay.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning' || DEBUG) log(e.level, `renderer: ${e.message}`)
  })
  overlay.on('closed', () => { overlay = null })

  // Dev aid: MANYAKI_SNAPSHOT=<file.png> periodically saves just this overlay (never the rest of the screen).
  const snap = process.env.MANYAKI_SNAPSHOT
  if (snap) {
    setInterval(async () => {
      if (!overlay || overlay.isDestroyed()) return
      const img = await overlay.webContents.capturePage()
      writeFileSync(snap, img.toPNG())
    }, 2000)
  }
}

let quitting = false
let lastStatus: unknown = null

/** The Home window: her control centre (status, toggles, focus, goals, chat) plus all settings. */
function openHome(tab: 'home' | 'settings' = 'home', inactive = false) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    if (inactive) settingsWin.showInactive()
    else { settingsWin.show(); settingsWin.moveTop(); settingsWin.focus() }
    settingsWin.webContents.send('tab', tab)
    return
  }
  settingsWin = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    title: 'Manyaki',
    icon: appIcon(256),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#fff7fb',
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: false, contextIsolation: true }
  })
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  load(settingsWin, 'settings')
  settingsWin.webContents.on('did-finish-load', () => { if (lastStatus) settingsWin?.webContents.send('status', lastStatus) })
  settingsWin.once('ready-to-show', () => {
    if (inactive) settingsWin?.showInactive()
    else settingsWin?.show()
    settingsWin?.webContents.send('tab', tab)
    if (lastStatus) settingsWin?.webContents.send('status', lastStatus)
  })
  // Closing the window just hides it; she keeps running (quit from the tray or the window's Quit button).
  settingsWin.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    settingsWin?.hide()
  })
  settingsWin.on('closed', () => { settingsWin = null })
}
const openSettings = () => openHome('settings')

let iconCache: Electron.NativeImage | null = null
/** Saves one of her angry letters into a folder on the Desktop and shows a notification that opens it. */
function writeLetter(fileName: string, body: string): string {
  const dir = join(app.getPath('desktop'), 'Letters from Manyaki')
  mkdirSync(dir, { recursive: true })
  // Only a plain .txt name inside that folder: no paths, no other extensions.
  const base = fileName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\.txt$/i, '').trim().slice(0, 90) || 'A letter'
  let path = join(dir, `${base}.txt`)
  for (let i = 2; existsSync(path); i++) path = join(dir, `${base} (${i}).txt`)
  writeFileSync(path, '﻿' + body.slice(0, 6000).replace(/\r?\n/g, '\r\n'), 'utf8')
  log('info', `letter written (${body.length} chars)`)
  if (Notification.isSupported()) {
    const n = new Notification({ title: 'Manyaki left you a letter 😭', body: 'Hmph. Click to read it.', icon: appIcon(128) })
    n.on('click', () => void shell.openPath(path))
    n.show()
  }
  return path
}

function appIcon(size: number) {
  if (!iconCache) iconCache = nativeImage.createFromPath(join(assetsRoot(), 'icon.png'))
  return iconCache.resize({ width: size, height: size, quality: 'best' })
}

function send(channel: string, payload: unknown) {
  for (const w of [overlay, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
}
const command = (cmd: Command) => overlay?.webContents.send('command', cmd)

/** Her control menu: shown from the tray icon and when you right-click her. */
function controlMenu(): Menu {
  const s = store.getSettings()
  // Kept short on purpose: the few things people reach for, plus one "More" for everything else.
  return Menu.buildFromTemplate([
    { label: 'Manyaki 💗', enabled: false },
    { label: '💬 Talk to her  (Ctrl+Alt+Space)', click: () => command({ type: 'toggle-listen' }) },
    { label: '⌨️ Type a message', click: () => command({ type: 'chat' }) },
    { label: '🛡️ Privacy shield (hide my private details)', type: 'checkbox', checked: s.privacyShield, click: (i) => applySettings({ privacyShield: i.checked }) },
    { label: '🌙 Do not disturb', type: 'checkbox', checked: s.dnd, click: (i) => applySettings({ dnd: i.checked }) },
    { label: '🙈 Hide for 30 minutes', click: () => command({ type: 'hide', minutes: 30 }) },
    { label: '🏠 Open Home', click: () => openHome('home') },
    { type: 'separator' },
    {
      label: 'More',
      submenu: [
        {
          label: 'Microphone',
          submenu: (['handsfree', 'toggle', 'off'] as const).map((m) => ({
            label: { handsfree: 'Hands-free (she hears you speak)', toggle: 'Only when I press Ctrl+Alt+Space', off: 'Off (typing only)' }[m],
            type: 'radio' as const,
            checked: s.micMode === m,
            click: () => applySettings({ micMode: m })
          }))
        },
        { label: 'Fix microphone (Windows privacy)…', click: () => void shell.openExternal('ms-settings:privacy-microphone') },
        { label: 'Mute her voice (text bubble only)', type: 'checkbox', checked: s.voiceMuted, click: (i) => applySettings({ voiceMuted: i.checked }) },
        { label: '👀 She can see my screen', type: 'checkbox', checked: s.screenSense, click: (i) => applySettings({ screenSense: i.checked }) },
        { label: '💞 Emotional attachment (sulks, cries, letters)', type: 'checkbox', checked: s.emotionalAttachment, click: (i) => applySettings({ emotionalAttachment: i.checked }) },
        { type: 'separator' },
        { label: `Start focus (${s.focusMinutes} min)`, click: () => command({ type: 'focus-start' }) },
        { label: 'Stop focus', click: () => command({ type: 'focus-stop' }) },
        { type: 'separator' },
        { label: '🎥 Stream-safe mode', type: 'checkbox', checked: s.streamSafe, click: (i) => applySettings({ streamSafe: i.checked }) },
        { label: '🔋 Battery saver (less smooth)', type: 'checkbox', checked: s.batterySaver, click: (i) => applySettings({ batterySaver: i.checked }) },
        { label: 'Send her to the corner', click: () => command({ type: 'corner' }) },
        { label: '🔄 Reset her position', click: () => command({ type: 'reset' }) },
        {
          label: 'Size',
          submenu: [180, 220, 260, 320, 400].map((px) => ({
            label: { 180: 'Tiny', 220: 'Small', 260: 'Medium', 320: 'Large', 400: 'Huge' }[px]!,
            type: 'radio' as const,
            checked: s.size === px,
            click: () => applySettings({ size: px })
          }))
        },
        { type: 'separator' },
        { label: 'Settings…', click: openSettings },
        { label: 'Launch at login', type: 'checkbox', checked: s.launchAtLogin, click: (i) => applySettings({ launchAtLogin: i.checked }) },
        { label: 'Open log folder', click: () => shell.showItemInFolder(logFile()) }
      ]
    },
    { label: 'Quit', click: () => app.quit() }
  ])
}

function buildTray() {
  const menu = controlMenu()
  if (!tray) {
    tray = new Tray(appIcon(32))
    tray.setToolTip('Manyaki')
    tray.on('click', () => openHome('home'))
  }
  tray.setContextMenu(menu)
}

/** Start (or stop) her browser-agent server to match the settings. */
async function syncEyes() {
  const s = store.getSettings()
  if (!s.eyesEnabled) { await stopEyes(); return }
  const info = await startEyes({
    settings: s,
    geminiKey: store.getApiKey(),
    pairing: store.getEyesPairing(newPairingCode),
    appPath: app.getAppPath(),
    onEvent: (e) => send('eyes', e),
    log
  })
  log('info', `eyes server ${info.running ? `on :${info.port}` : `off (${info.error})`}`)
}

// ---------- screen sense: she always knows what's in front (on-device, redacted, memory only) ----------
let lastActivity: ActivitySnapshot | null = null
let lastGlanceKey = ''
function startSenseLoop() {
  setInterval(async () => {
    const s = store.getSettings()
    if (!s.screenSense || s.dnd || !lastActivity || lastActivity.category === 'self') return
    const g = await desk.senseOnce({ idleSeconds: lastActivity.idleSeconds, fullscreen: lastActivity.fullscreen })
    const key = g ? `${g.at}` : ''
    if (key && key !== lastGlanceKey) {
      lastGlanceKey = key
      overlay?.webContents.send('glance', g)
      if (g) log('info', `glance: ${g.private ? 'private window' : `${g.app}, ${g.lines.length} lines`}${g.error ? ', error on screen' : ''}`)
    }
  }, 5000)
}

function applySettings(patch: Partial<Settings>): Settings {
  const next = store.setSettings(patch)
  if ('privacyShield' in patch) desk.setShield(next.privacyShield)
  if ('screenSense' in patch && !next.screenSense) { desk.clearGlance(); overlay?.webContents.send('glance', null) }
  if ('eyesEnabled' in patch) void syncEyes()
  else if ('eyesPlanner' in patch) setEyesProvider(next, store.getApiKey())
  if ('launchAtLogin' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
  send('settings', next)
  buildTray()
  return next
}

function registerIpc() {
  ipcMain.handle('display:get', () => displayInfo())
  ipcMain.on('window:rect', (e, r: { x: number; y: number; width: number; height: number }) => {
    if (!overlay) { e.returnValue = r; return }
    const d = displayInfo().bounds
    const want = { x: Math.round(d.x + r.x), y: Math.round(d.y + r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) }
    const cur = overlay.getBounds()
    if (cur.width !== want.width || cur.height !== want.height) overlay.setBounds(want)
    else if (cur.x !== want.x || cur.y !== want.y) overlay.setPosition(want.x, want.y)
    const got = overlay.getBounds()
    e.returnValue = { x: got.x - d.x, y: got.y - d.y, width: got.width, height: got.height }
  })
  ipcMain.on('mouse:ignore', (_e, ignore: boolean) => overlay?.setIgnoreMouseEvents(ignore, { forward: true }))
  ipcMain.on('window:focusable', (_e, focusable: boolean) => {
    if (!overlay) return
    overlay.setFocusable(focusable)
    if (focusable) overlay.focus()
    else overlay.blur()
  })
  ipcMain.handle('key:get', (e) => (fromOurWindow(e.sender) ? store.getApiKey() : ''))
  ipcMain.handle('key:has', () => !!store.getApiKey())
  ipcMain.handle('key:set', (_e, key: string) => {
    const ok = store.setApiKey(key)
    log('warn', `api key ${key.trim() ? 'saved' : 'cleared'} (ok=${ok}, length ${key.trim().length})`)
    if (ok) {
      command({ type: 'reload-key' })
      setEyesProvider(store.getSettings(), store.getApiKey())
    }
    return ok
  })
  // Desktop hands: only her own windows may drive them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deskOp = <A extends any[]>(name: string, f: (...a: A) => Promise<unknown>) =>
    ipcMain.handle(`desk:${name}`, async (e, ...args) => {
      if (!fromOurWindow(e.sender)) return 'not allowed'
      try { return await f(...(args as A)) } catch (err) { log('warn', `desk ${name}: ${(err as Error).message}`); return `failed: ${(err as Error).message}` }
    })
  deskOp('windows', () => desk.listWindows())
  deskOp('window', (q: string, op: WindowOp) => desk.windowAction(String(q), op))
  deskOp('close-all', (q: string) => desk.closeAll(String(q)))
  deskOp('read-app', (q?: string) => desk.readApp(q ? String(q) : undefined))
  deskOp('press', (id: string) => desk.pressControl(String(id)))
  deskOp('type-into', (id: string, t: string) => desk.typeInto(String(id), String(t)))
  deskOp('type', (t: string) => desk.typeText(String(t)))
  deskOp('keys', (c: string) => desk.pressKeys(String(c)))
  deskOp('scroll', (d: 'up' | 'down', n?: number) => desk.scroll(d === 'up' ? 'up' : 'down', Number(n) || 3))
  deskOp('click-text', (t: string, dbl?: boolean) => desk.clickText(String(t), !!dbl))
  deskOp('see', () => desk.seeScreen())
  ipcMain.handle('desk:screenshot', async (e) => {
    if (!fromOurWindow(e.sender)) return { error: 'not allowed' }
    try { return await desk.screenshotForModel() } catch (err) { return { error: (err as Error).message } }
  })
  ipcMain.handle('eyes:task', (e, text: string) => (fromOurWindow(e.sender) ? eyesTask(String(text).slice(0, 500)) : false))
  ipcMain.handle('eyes:info', () => eyesInfo())
  ipcMain.handle('eyes:open-extension', async () => {
    const dir = app.isPackaged ? join(process.resourcesPath, 'eyes', 'extension') : join(app.getAppPath(), 'eyes', 'extension', 'dist')
    if (!existsSync(join(dir, 'manifest.json'))) return 'not built yet: run npm run eyes:build'
    return (await shell.openPath(dir)) || dir
  })
  ipcMain.handle('eyes:new-pairing', async (e) => {
    if (!fromOurWindow(e.sender)) return eyesInfo()
    store.setEyesPairing(newPairingCode())
    await syncEyes()
    return eyesInfo()
  })
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => applySettings(patch))
  ipcMain.handle('memory:get', () => store.getMemory())
  ipcMain.handle('memory:set', (e, data) => {
    store.setMemory(data)
    for (const w of [overlay, settingsWin]) if (w && !w.isDestroyed() && w.webContents !== e.sender) w.webContents.send('memory', store.getMemory())
  })
  ipcMain.handle('memory:wipe', () => {
    store.wipeMemory()
    send('memory', store.getMemory())
  })
  ipcMain.handle('memory:export', async () => {
    const res = await dialog.showSaveDialog({ defaultPath: 'manyaki-memory.json' })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, JSON.stringify(store.getMemory(), null, 2))
    return res.filePath
  })
  ipcMain.handle('anims:list', () => listAnims())
  // One screenshot of the primary display, only when the user asks her to look. Never written to disk.
  ipcMain.handle('screen:capture', async () => {
    const d = screen.getPrimaryDisplay()
    const scale = Math.min(1, 1280 / d.size.width)
    overlay?.setOpacity(0) // keep herself out of the picture
    try {
      await new Promise((r) => setTimeout(r, 120))
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) } })
      const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0]
      return src ? src.thumbnail.toJPEG(72).toString('base64') : null
    } finally {
      overlay?.setOpacity(1)
    }
  })
  ipcMain.handle('local:status', () => askBrain({ type: 'status' }, 10000).catch(() => brainStatus))
  ipcMain.handle('local:download', () => askBrain({ type: 'download' }, 6 * 3600000))
  ipcMain.handle('local:warm', (_e, system?: string) => askBrain({ type: 'warm', system }, 300000).catch(() => brainStatus))
  ipcMain.handle('local:chat', (_e, system: string, history: unknown, text: string, teach?: boolean) => askBrain({ type: 'chat', system, history, text, teach }, 120000))
  ipcMain.handle('local:transcribe', (_e, audio: Float32Array) => askBrain({ type: 'transcribe', audio }, 60000))
  ipcMain.handle('local:tts', (_e, text: string, voice: string) => askBrain({ type: 'tts', text, voice }, 60000))
  ipcMain.handle('local:emotion', (_e, texts: string[]) => askBrain({ type: 'emotion', texts: (Array.isArray(texts) ? texts : []).slice(0, 4).map(String) }, 180000).catch(() => null))
  ipcMain.handle('action:run', async (_e, kind: ActionKind, target: string) => {
    const r = await runAction(kind, target)
    log('info', `action ${kind} "${String(target).slice(0, 60)}" -> ${r.ok ? 'opened' : r.error}`)
    return r
  })
  ipcMain.handle('letter:write', (e, fileName: string, body: string) => {
    if (!fromOurWindow(e.sender)) return { ok: false, error: 'not allowed' }
    try { return { ok: true, path: writeLetter(String(fileName), String(body)) } } catch (err) {
      log('warn', `letter: ${(err as Error).message}`)
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.on('notify', (_e, title: string, body: string) => {
    if (Notification.isSupported()) new Notification({ title, body, icon: appIcon(128), silent: false }).show()
  })
  ipcMain.on('settings:open', openSettings)
  ipcMain.on('home:open', () => openHome('home'))
  ipcMain.on('command:send', (_e, cmd: Command) => command(cmd))
  ipcMain.on('status:report', (_e, st: unknown) => {
    lastStatus = st
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('status', st)
  })
  ipcMain.on('app:quit', () => app.quit())
  ipcMain.on('menu:popup', () => { if (overlay) controlMenu().popup({ window: overlay }) })
  ipcMain.on('log', (_e, level: string, msg: string) => log(level, msg))
}

const fromOurWindow = (wc: Electron.WebContents) => wc === overlay?.webContents || wc === settingsWin?.webContents

function listAnims(): string[] {
  const out: string[] = []
  const dirs: [string, string][] = [[join(assetsRoot(), 'anims'), 'anims'], [userAnimsDir(), 'user-anims']]
  for (const [dir, host] of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) if (/\.(fbx|vrma)$/i.test(f)) out.push(`${ASSET_SCHEME}://${host}/${encodeURIComponent(f)}`)
  }
  return out
}

function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, (req) => {
    const url = new URL(req.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const base = url.host === 'user-anims' ? userAnimsDir() : join(assetsRoot(), url.host)
    const full = join(base, rel)
    if (!full.startsWith(base)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(full).toString())
  })
}

app.on('second-instance', () => openHome('home'))

app.whenReady().then(() => {
  app.setAppUserModelId('com.naman.manyaki')
  mkdirSync(userAnimsDir(), { recursive: true })
  registerAssetProtocol()

  // Microphone access for her ears; nothing else is requested.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'notifications'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'notifications')

  desk.initDesk({ script: join(assetsRoot(), 'desk', 'host.ps1'), log })
  desk.setShield(store.getSettings().privacyShield)
  registerIpc()
  createOverlay()
  buildTray()
  void syncEyes()
  // Warm her hands a few seconds after start so the first request is instant.
  setTimeout(() => void desk.warmDesk(), 6000)
  startSenseLoop()
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: store.getSettings().launchAtLogin })

  globalShortcut.register('Control+Alt+Space', () => command({ type: 'toggle-listen' }))
  globalShortcut.register('Control+Alt+E', () => command({ type: 'look' }))

  // Her eyes follow the cursor anywhere on screen, not only over her small window.
  let lastCursor = ''
  setInterval(() => {
    if (!overlay || overlay.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    const d = displayInfo().bounds
    const key = `${p.x},${p.y}`
    if (key === lastCursor) return
    lastCursor = key
    overlay.webContents.send('cursor', { x: p.x - d.x, y: p.y - d.y })
  }, 50)

  stopActivity = startActivityWatcher(process.pid, (a) => { lastActivity = a; overlay?.webContents.send('activity', a) })

  const onDisplay = () => {
    const info = displayInfo()
    if (DEBUG) overlay?.setBounds(info.bounds)
    send('display', info)
  }
  screen.on('display-metrics-changed', onDisplay)
  screen.on('display-added', onDisplay)
  screen.on('display-removed', onDisplay)

  // Home opens on start (quietly, without stealing focus) so her controls are always one click away;
  // first run goes straight to the key setup.
  if (!store.getSettings().onboarded || !store.getApiKey()) setTimeout(openSettings, 2500)
  else setTimeout(() => openHome('home', true), 2500)
  log('info', `Manyaki started; data at ${store.storePath()}`)
})

app.on('before-quit', () => { quitting = true; brain?.kill(); void stopEyes(); desk.stopDesk() })

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopActivity?.()
})

app.on('window-all-closed', () => {
  // The overlay is the app; if it is gone, quit.
  if (!overlay) app.quit()
})

process.on('uncaughtException', (err) => log('error', `main uncaught: ${err.stack ?? err}`))
