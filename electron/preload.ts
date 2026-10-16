import { contextBridge, ipcRenderer } from 'electron'
import type { Bridge } from '../shared/types'

const bridge: Bridge = {
  platform: process.platform,
  debug: process.argv.includes('--manyaki-debug'),
  getDisplay: () => ipcRenderer.invoke('display:get'),
  followWindow: !process.argv.includes('--manyaki-debug'),
  setWindowRect: (r) => ipcRenderer.sendSync('window:rect', r),
  setIgnoreMouse: (ignore) => ipcRenderer.send('mouse:ignore', ignore),
  setFocusable: (focusable) => ipcRenderer.send('window:focusable', focusable),
  getApiKey: () => ipcRenderer.invoke('key:get'),
  setApiKey: (key) => ipcRenderer.invoke('key:set', key),
  hasApiKey: () => ipcRenderer.invoke('key:has'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getMemory: () => ipcRenderer.invoke('memory:get'),
  setMemory: (data) => ipcRenderer.invoke('memory:set', data),
  wipeMemory: () => ipcRenderer.invoke('memory:wipe'),
  exportMemory: () => ipcRenderer.invoke('memory:export'),
  notify: (title, body) => ipcRenderer.send('notify', title, body),
  openSettings: () => ipcRenderer.send('settings:open'),
  showMenu: () => ipcRenderer.send('menu:popup'),
  listAnims: () => ipcRenderer.invoke('anims:list'),
  runAction: (kind, target) => ipcRenderer.invoke('action:run', kind, target),
  log: (level, msg) => ipcRenderer.send('log', level, msg),
  on: ((channel: string, cb: (payload: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => { ipcRenderer.removeListener(channel, handler) }
  }) as Bridge['on']
}

contextBridge.exposeInMainWorld('manyaki', bridge)
