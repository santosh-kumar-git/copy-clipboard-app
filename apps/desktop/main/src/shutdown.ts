import type { Logger } from '@cairn/protocol'

interface QuitApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): void
  quit(): void
}

export function registerShutdown(app: QuitApp, stop: () => Promise<void>, logger: Logger): void {
  let stopping = false
  let finished = false
  app.on('before-quit', (event) => {
    if (finished) return
    event.preventDefault()
    if (stopping) return
    stopping = true
    void Promise.resolve().then(stop).catch(() => {
      logger.error('app.quitting', { ok: false, code: 'E_INTERNAL' })
    }).finally(() => {
      finished = true
      app.quit()
    })
  })
}
