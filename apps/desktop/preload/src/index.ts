import { contextBridge, ipcRenderer } from 'electron'
import type { IpcEventChannel } from '@cairn/protocol'

/**
 * Spec §11 control 4. TWELVE methods, each with its channel written out as a string literal in the
 * call. There is deliberately no `invoke(channel, params)` and no `send`: a generic bridge means
 * every current and future main-process handler is reachable from any script that gets into the
 * page, and the whole decrypted history is one call behind those handlers.
 *
 * `subscribe` is a local helper, not an exposed method, so the page cannot pick its own channel.
 */
function subscribe(channel: IpcEventChannel, cb: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => { cb(payload) }
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

contextBridge.exposeInMainWorld('cairn', {
  list: (params: unknown) => ipcRenderer.invoke('cairn:history.list', params),
  search: (params: unknown) => ipcRenderer.invoke('cairn:history.search', params),
  preview: (params: unknown) => ipcRenderer.invoke('cairn:history.preview', params),
  pin: (params: unknown) => ipcRenderer.invoke('cairn:history.pin', params),
  remove: (params: unknown) => ipcRenderer.invoke('cairn:history.remove', params),
  copy: (params: unknown) => ipcRenderer.invoke('cairn:recall.copy', params),
  close: () => ipcRenderer.invoke('cairn:palette.close', {}),
  securityStatus: () => ipcRenderer.invoke('cairn:security.status', {}),
  onHistoryChanged: (cb: (payload: unknown) => void) => subscribe('cairn:history.changed', cb),
  onHotkeyStatus: (cb: (payload: unknown) => void) => subscribe('cairn:hotkey.status', cb),
  onToast: (cb: (payload: unknown) => void) => subscribe('cairn:toast', cb),
  onPaletteShown: (cb: (payload: unknown) => void) => subscribe('cairn:palette.shown', cb),
})
