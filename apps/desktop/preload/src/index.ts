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

/**
 * Every main handler answers with a `Result<T>` — `{ ok: true, value }` or `{ ok: false, code }` —
 * but `CairnBridge` in the renderer declares the UNWRAPPED value and the renderer's own error
 * handling is try/catch. So the wrapper is unwrapped exactly once, here, at the boundary that owns
 * the difference.
 *
 * This is the layer where the mistake was invisible: `ipcRenderer.invoke` returns `Promise<any>`, so
 * handing the wrapper straight to the renderer type-checked cleanly, and then EVERY call failed at
 * runtime — `res.items` was undefined, `[...res.items]` threw, and the palette showed "Cairn could
 * not read its history" over an empty list while the main process logged a perfectly good
 * `ipc.served count:31`.
 *
 * Rejects with the CODE only. `Err.message` can carry a prettified zod dump of the offending value,
 * and a renderer exception can reach a devtools console or a future error surface, so the message
 * stays in the main process where it was already logged.
 */
async function unwrap(pending: Promise<unknown>): Promise<unknown> {
  const res = await pending
  if (typeof res !== 'object' || res === null) throw new Error('E_INTERNAL')
  const bag = res as { ok?: unknown; value?: unknown; code?: unknown }
  if (bag.ok === true) return bag.value
  throw new Error(typeof bag.code === 'string' ? bag.code : 'E_INTERNAL')
}

contextBridge.exposeInMainWorld('cairn', {
  list: (params: unknown) => unwrap(ipcRenderer.invoke('cairn:history.list', params)),
  search: (params: unknown) => unwrap(ipcRenderer.invoke('cairn:history.search', params)),
  preview: (params: unknown) => unwrap(ipcRenderer.invoke('cairn:history.preview', params)),
  pin: (params: unknown) => unwrap(ipcRenderer.invoke('cairn:history.pin', params)),
  remove: (params: unknown) => unwrap(ipcRenderer.invoke('cairn:history.remove', params)),
  copy: (params: unknown) => unwrap(ipcRenderer.invoke('cairn:recall.copy', params)),
  close: () => unwrap(ipcRenderer.invoke('cairn:palette.close', {})),
  securityStatus: () => unwrap(ipcRenderer.invoke('cairn:security.status', {})),
  onHistoryChanged: (cb: (payload: unknown) => void) => subscribe('cairn:history.changed', cb),
  onHotkeyStatus: (cb: (payload: unknown) => void) => subscribe('cairn:hotkey.status', cb),
  onToast: (cb: (payload: unknown) => void) => subscribe('cairn:toast', cb),
  onPaletteShown: (cb: (payload: unknown) => void) => subscribe('cairn:palette.shown', cb),
})
