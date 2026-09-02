import type { LogFields } from './log'

export interface Ok<T> { readonly ok: true; readonly value: T }
export interface Err {
  readonly ok: false
  readonly code: ErrorCode
  readonly message: string
  readonly detail?: LogFields
}
export type Result<T> = Ok<T> | Err

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value })
export const err = (code: ErrorCode, message: string, detail?: LogFields): Err =>
  detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail }

export const ERROR_CODES = [
  // wire / transport
  'E_PARSE', 'E_LINE_TOO_LONG', 'E_WIRE_MAJOR', 'E_BAD_PARAMS', 'E_UNKNOWN_METHOD', 'E_INTERNAL',
  'E_TIMEOUT', 'E_AGENT_SPAWN', 'E_AGENT_EXIT', 'E_AGENT_DISPOSED',
  // byte transport (spec §4)
  'E_REP_UNKNOWN_ID', 'E_REP_SEQ_GAP', 'E_REP_SEQ_DUPLICATE', 'E_REP_AFTER_FINAL',
  'E_REP_BAD_BASE64', 'E_REP_OVERFLOW', 'E_REP_SHORT', 'E_REP_HASH_MISMATCH',
  'E_REP_TIMEOUT', 'E_REP_TOO_MANY',
  // store
  'E_STORE_CORRUPT', 'E_STORE_CHAIN_BROKEN', 'E_STORE_DECRYPT', 'E_STORE_IO', 'E_BLOB_MISSING',
  // keyring
  'E_KEYRING_UNAVAILABLE', 'E_KEYRING_WEAK_BACKEND', 'E_KEYRING_BAD_PASSPHRASE', 'E_KEYRING_LOCKED',
  // domain
  'E_ITEM_NOT_FOUND', 'E_ITEM_EXPIRED', 'E_PIN_REFUSED_SECRET',
  // hotkey / ipc
  'E_HOTKEY_TAKEN', 'E_HOTKEY_INVALID', 'E_IPC_REJECTED',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]
