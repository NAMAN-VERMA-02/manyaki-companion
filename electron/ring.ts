import { BrowserWindow, screen } from 'electron'
import { ringHtml, type Box } from '../shared/desk'

// The pink circle she draws around what she's talking about. A click-through window over the primary
// display, kept hidden between uses: a shown full-screen transparent window costs CPU on every frame.

let win: BrowserWindow | null = null
let timer: NodeJS.Timeout | undefined

export async function showRing(box: Box, ms = 8000) {
  const d = screen.getPrimaryDisplay()
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      ...d.bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      backgroundColor: '#00000000',
      title: 'Manyaki',
      webPreferences: { sandbox: true, contextIsolation: true }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true)
  }
  win.setBounds(d.bounds)
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(ringHtml(box))}`)
  win.showInactive()
  clearTimeout(timer)
  timer = setTimeout(hideRing, ms)
}

export function hideRing() {
  clearTimeout(timer)
  if (win && !win.isDestroyed()) win.hide()
}
