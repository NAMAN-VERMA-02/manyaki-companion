import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, protocol, screen, session, shell, Tray } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Command, DisplayInfo, Settings } from '../shared/types'
import { startActivityWatcher } from './activity'
import * as store from './store'

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

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 720,
    title: 'Manyaki · Settings',
    icon: appIcon(256),
    autoHideMenuBar: true,
    backgroundColor: '#fff7fb',
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: false, contextIsolation: true }
  })
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  load(settingsWin, 'settings')
  settingsWin.on('closed', () => { settingsWin = null })
}

let iconCache: Electron.NativeImage | null = null
function appIcon(size: number) {
  if (!iconCache) iconCache = nativeImage.createFromPath(join(assetsRoot(), 'icon.png'))
  return iconCache.resize({ width: size, height: size, quality: 'best' })
}

function send(channel: string, payload: unknown) {
  for (const w of [overlay, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
}
const command = (cmd: Command) => overlay?.webContents.send('command', cmd)

function buildTray() {
  const s = store.getSettings()
  const menu = Menu.buildFromTemplate([
    { label: 'Manyaki 💗', enabled: false },
    { type: 'separator' },
    { label: 'Talk to her  (Ctrl+Alt+Space)', click: () => command({ type: 'toggle-listen' }) },
    { label: 'Type a message…', click: () => command({ type: 'chat' }) },
    {
      label: 'Microphone',
      submenu: (['handsfree', 'toggle', 'off'] as const).map((m) => ({
        label: { handsfree: 'Hands-free (she hears you speak)', toggle: 'Only when I press Ctrl+Alt+Space', off: 'Off (typing only)' }[m],
        type: 'radio' as const,
        checked: s.micMode === m,
        click: () => applySettings({ micMode: m })
      }))
    },
    { type: 'separator' },
    { label: `Start focus (${s.focusMinutes} min)`, click: () => command({ type: 'focus-start' }) },
    { label: 'Stop focus', click: () => command({ type: 'focus-stop' }) },
    { type: 'separator' },
    { label: 'Do not disturb', type: 'checkbox', checked: s.dnd, click: (i) => applySettings({ dnd: i.checked }) },
    { label: 'Send her to the corner', click: () => command({ type: 'corner' }) },
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
    { label: 'Open log folder', click: () => shell.showItemInFolder(logFile()) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
  if (!tray) {
    tray = new Tray(appIcon(32))
    tray.setToolTip('Manyaki')
    tray.on('click', () => command({ type: 'say-hi' }))
  }
  tray.setContextMenu(menu)
}

function applySettings(patch: Partial<Settings>): Settings {
  const next = store.setSettings(patch)
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
    if (ok) command({ type: 'reload-key' })
    return ok
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
  ipcMain.on('notify', (_e, title: string, body: string) => {
    if (Notification.isSupported()) new Notification({ title, body, icon: appIcon(128), silent: false }).show()
  })
  ipcMain.on('settings:open', openSettings)
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

app.on('second-instance', () => command({ type: 'say-hi' }))

app.whenReady().then(() => {
  app.setAppUserModelId('com.naman.manyaki')
  mkdirSync(userAnimsDir(), { recursive: true })
  registerAssetProtocol()

  // Microphone access for her ears; nothing else is requested.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'notifications'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'notifications')

  registerIpc()
  createOverlay()
  buildTray()
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: store.getSettings().launchAtLogin })

  globalShortcut.register('Control+Alt+Space', () => command({ type: 'toggle-listen' }))

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

  stopActivity = startActivityWatcher(process.pid, (a) => overlay?.webContents.send('activity', a))

  const onDisplay = () => {
    const info = displayInfo()
    if (DEBUG) overlay?.setBounds(info.bounds)
    send('display', info)
  }
  screen.on('display-metrics-changed', onDisplay)
  screen.on('display-added', onDisplay)
  screen.on('display-removed', onDisplay)

  if (!store.getSettings().onboarded || !store.getApiKey()) setTimeout(openSettings, 2500)
  log('info', `Manyaki started; data at ${store.storePath()}`)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopActivity?.()
})

app.on('window-all-closed', () => {
  // The overlay is the app; if it is gone, quit.
  if (!overlay) app.quit()
})

process.on('uncaughtException', (err) => log('error', `main uncaught: ${err.stack ?? err}`))
