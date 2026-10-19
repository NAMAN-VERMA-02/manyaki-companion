import { contextBridge, ipcRenderer } from 'electron'
import type { Bridge } from '../shared/types'

const bridge: Bridge = {
  platform: process.platform,
  homeDir: require('node:os').homedir(),
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
  writeLetter: (fileName, body) => ipcRenderer.invoke('letter:write', fileName, body),
  openSettings: () => ipcRenderer.send('settings:open'),
  openHome: () => ipcRenderer.send('home:open'),
  quit: () => ipcRenderer.send('app:quit'),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  local: {
    status: () => ipcRenderer.invoke('local:status'),
    download: () => ipcRenderer.invoke('local:download'),
    warm: (system) => ipcRenderer.invoke('local:warm', system),
    chat: (system, history, text, teach) => ipcRenderer.invoke('local:chat', system, history, text, teach),
    transcribe: (audio) => ipcRenderer.invoke('local:transcribe', audio),
    tts: (text, voice) => ipcRenderer.invoke('local:tts', text, voice)
  },
  sendCommand: (cmd) => ipcRenderer.send('command:send', cmd),
  reportStatus: (s) => ipcRenderer.send('status:report', s),
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
