import {
  err,
  ok,
  type ClipboardAgent,
  type HotkeyFiredPayload,
  type Logger,
  type Result,
  type Unsub,
} from '@cairn/protocol'

export type HotkeyStatus = 'active' | 'unbound' | 'failed'

const MODIFIERS = ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']
const NAMED_KEYS = [
  'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'Plus', 'CapsLock', 'NumLock', 'ScrollLock',
  'PrintScreen',
]

/**
 * `Modifier+…+Key`. At least one modifier is MANDATORY: a bare `V` registered globally would
 * swallow every V typed on the machine, which is unrecoverable without a rebind UI the user
 * cannot reach because typing in it is broken.
 */
export const ACCELERATOR_RE = new RegExp(
  `^(?:(?:${MODIFIERS.join('|')})\\+)+(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|${NAMED_KEYS.join('|')})$`,
)

export function isValidAccelerator(accelerator: string): boolean {
  return accelerator.length > 0 && accelerator.length <= 64 && ACCELERATOR_RE.test(accelerator)
}

/** Offered in the rebind row when `status() === 'failed'`. First entry is the shipped default. */
export const SUGGESTED_ACCELERATORS = ['Cmd+Shift+V', 'Cmd+Shift+C', 'Cmd+Alt+V', 'Ctrl+Shift+V'] as const

export interface Hotkey {
  bind(accelerator: string): Promise<Result<{ accelerator: string }>>
  unbind(): Promise<Result<{ bound: false }>>
  current(): string | null
  status(): HotkeyStatus
  onTrigger(cb: (e: HotkeyFiredPayload) => void): Unsub
}

export function createHotkey(deps: { agent: ClipboardAgent; logger: Logger }): Hotkey {
  const { agent, logger } = deps
  let accelerator: string | null = null
  let status: HotkeyStatus = 'unbound'
  const subscribers = new Set<(e: HotkeyFiredPayload) => void>()

  agent.on('hotkey.fired', (payload) => {
    logger.debug('hotkey.fired', { accelerator: payload.accelerator })
    for (const cb of [...subscribers]) {
      // One bad subscriber must not silence the rest; the palette failing to open is the
      // product's only entry point failing.
      try {
        cb(payload)
      } catch {
        logger.warn('hotkey.fired', { ok: false })
      }
    }
  })

  return {
    async bind(next) {
      if (!isValidAccelerator(next)) {
        logger.warn('hotkey.bind-failed', { accelerator: next, code: 'E_HOTKEY_INVALID' })
        return err('E_HOTKEY_INVALID', `not a valid accelerator: ${next}`, { accelerator: next })
      }
      const res = await agent.request('hotkey.register', { accelerator: next })
      accelerator = next
      if (!res.ok) {
        status = 'failed'
        logger.warn('hotkey.bind-failed', { accelerator: next, code: res.code })
        return res
      }
      // THE POINT OF THIS PACKAGE: a taken combination is a SUCCESSFUL response carrying
      // `bound: false`. Not checking it is how this app class ships a silently dead hotkey.
      if (!res.value.bound) {
        status = 'failed'
        logger.warn('hotkey.bind-failed', { accelerator: next, code: 'E_HOTKEY_TAKEN' })
        return err('E_HOTKEY_TAKEN', `another application already owns ${next}`, { accelerator: next })
      }
      status = 'active'
      logger.info('hotkey.bound', { accelerator: next })
      return ok({ accelerator: next })
    },
    async unbind() {
      const res = await agent.request('hotkey.unregister', {})
      if (!res.ok) return res
      accelerator = null
      status = 'unbound'
      return ok({ bound: false as const })
    },
    current: () => accelerator,
    status: () => status,
    onTrigger(cb) {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },
  }
}
