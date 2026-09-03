import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import * as z from 'zod'
import {
  DEFAULT_ACCELERATOR,
  RETENTION_MAX_BYTES,
  RETENTION_MAX_ITEMS,
} from '@cairn/protocol'

export const CONFIG_FILE_NAME = 'config.json'

/** Deliberately tiny. Nothing here is derived from clipboard content, which is why this is the one
 *  plaintext file Cairn writes: an accelerator string, a boolean and three integers. */
export const ConfigSchema = z.object({
  version: z.literal(1),
  accelerator: z.string().min(1).max(64),
  firstRunHotkeyDone: z.boolean(),
  retention: z.object({
    /** THE user-facing setting: keep the last N items. Everything else is a safety net. */
    maxItems: z.int().min(1).max(5_000),
    /**
     * null = never expire by age, and that is the DEFAULT. "Keep the last 200 items" means exactly
     * that; having a copy vanish at 30 days regardless of the count is a different promise, and a
     * surprising one. Age eviction stays available for anyone who wants it, opt-in only.
     */
    maxAgeMs: z.int().min(60_000).nullable(),
    maxBytes: z.int().min(1_048_576),
  }),
})

export type CairnConfig = z.output<typeof ConfigSchema>

export const DEFAULT_CONFIG: CairnConfig = {
  version: 1,
  accelerator: DEFAULT_ACCELERATOR,
  firstRunHotkeyDone: false,
  retention: {
    maxItems: RETENTION_MAX_ITEMS,
    maxAgeMs: null,
    maxBytes: RETENTION_MAX_BYTES,
  },
}

export function configPath(dataDir: string): string {
  return join(dataDir, CONFIG_FILE_NAME)
}

/**
 * Never throws. A corrupt, truncated or hand-edited file becomes the defaults, because an app that
 * refuses to launch is an app that has taken your clipboard history hostage. The caller logs
 * `config.loaded-default` when `source !== 'file'`.
 */
export function loadConfig(dataDir: string): {
  readonly config: CairnConfig
  readonly source: 'file' | 'default' | 'invalid'
} {
  let text: string
  try {
    text = readFileSync(configPath(dataDir), 'utf8')
  } catch {
    return { config: DEFAULT_CONFIG, source: 'default' }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { config: DEFAULT_CONFIG, source: 'invalid' }
  }
  const parsed = ConfigSchema.safeParse(json)
  if (!parsed.success) return { config: DEFAULT_CONFIG, source: 'invalid' }
  return { config: parsed.data, source: 'file' }
}

/**
 * `0700` dir, `0600` file, asserted by `config.security.test.ts` (spec §11 in-scope: "the data dir
 * is 0700 and every file 0600").
 *
 * The open/write/fchmod sequence is deliberate and verified: `writeFileSync(p, d, {mode: 0o600})`
 * applies its mode ONLY when creating the file — on a pre-existing `0644` file it leaves the mode at
 * `644`, so the config stays world-readable forever after one bad first write. `fchmodSync` on the
 * open descriptor narrows it every time, and `fsyncSync` means the hotkey choice survives a power
 * cut.
 */
export function saveConfig(dataDir: string, config: CairnConfig): void {
  const validated = ConfigSchema.parse(config)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const fd = openSync(configPath(dataDir), 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(validated, null, 2) + '\n')
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
