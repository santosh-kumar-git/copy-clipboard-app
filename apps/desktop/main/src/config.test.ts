import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ACCELERATOR, RETENTION_MAX_BYTES, RETENTION_MAX_ITEMS } from '@cairn/protocol'
import { CONFIG_FILE_NAME, ConfigSchema, configPath, DEFAULT_CONFIG, loadConfig, saveConfig } from './config'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cairn-cfg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('DEFAULT_CONFIG', () => {
  it('ships the accelerator the first-run step pre-selects and a COUNT-only retention default', () => {
    expect(DEFAULT_CONFIG).toEqual({
      version: 1,
      accelerator: DEFAULT_ACCELERATOR,
      firstRunHotkeyDone: false,
      retention: {
        maxItems: RETENTION_MAX_ITEMS,
        // null, not 30 days. The product promise is "the last N copies", so nothing expires merely
        // for being old; a copy from last year is still one of the last N until N newer ones exist.
        maxAgeMs: null,
        maxBytes: RETENTION_MAX_BYTES,
      },
    })
    expect(DEFAULT_CONFIG.accelerator).toBe('Cmd+Shift+V')
    expect(DEFAULT_CONFIG.retention.maxItems).toBe(500)
  })

  it('accepts an opt-in age limit but never invents one', () => {
    const withAge = ConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      retention: { ...DEFAULT_CONFIG.retention, maxAgeMs: 60_000 },
    })
    expect(withAge.success).toBe(true)
    // Below the floor is still rejected, so "opt-in" does not mean "unvalidated".
    const tooSmall = ConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      retention: { ...DEFAULT_CONFIG.retention, maxAgeMs: 59_999 },
    })
    expect(tooSmall.success).toBe(false)
  })
})

describe('configPath', () => {
  it('sits beside the store inside the data dir', () => {
    expect(configPath('/data/Cairn')).toBe(join('/data/Cairn', CONFIG_FILE_NAME))
    expect(CONFIG_FILE_NAME).toBe('config.json')
  })
})

describe('loadConfig', () => {
  it('returns the defaults and says so when there is no file', () => {
    expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, source: 'default' })
  })

  it('round-trips a saved config', () => {
    const chosen = { ...DEFAULT_CONFIG, accelerator: 'Cmd+Shift+C', firstRunHotkeyDone: true }
    saveConfig(dir, chosen)
    expect(loadConfig(dir)).toEqual({ config: chosen, source: 'file' })
  })

  it('survives a relaunch: a second load sees the same value', () => {
    saveConfig(dir, { ...DEFAULT_CONFIG, accelerator: 'Cmd+Alt+V', firstRunHotkeyDone: true })
    const first = loadConfig(dir)
    const second = loadConfig(dir)
    expect(second).toEqual(first)
    expect(second.config.accelerator).toBe('Cmd+Alt+V')
  })

  it('falls back to defaults on unparseable JSON instead of throwing', () => {
    writeFileSync(configPath(dir), '{ this is not json', { mode: 0o600 })
    expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, source: 'invalid' })
  })

  it('falls back to defaults when a field has the wrong type', () => {
    writeFileSync(configPath(dir), JSON.stringify({ ...DEFAULT_CONFIG, accelerator: 42 }), { mode: 0o600 })
    expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, source: 'invalid' })
  })

  it('falls back to defaults for a future schema version rather than guessing', () => {
    writeFileSync(configPath(dir), JSON.stringify({ ...DEFAULT_CONFIG, version: 2 }), { mode: 0o600 })
    expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, source: 'invalid' })
  })

  it('ignores unknown keys a future version might add', () => {
    writeFileSync(
      configPath(dir),
      JSON.stringify({ ...DEFAULT_CONFIG, accelerator: 'Cmd+Shift+C', somethingNew: true }),
      { mode: 0o600 },
    )
    const loaded = loadConfig(dir)
    expect(loaded.source).toBe('file')
    expect(loaded.config.accelerator).toBe('Cmd+Shift+C')
    expect((loaded.config as unknown as Record<string, unknown>)['somethingNew']).toBeUndefined()
  })
})

describe('saveConfig', () => {
  it('creates the data dir when it does not exist yet', () => {
    const nested = join(dir, 'deep', 'Cairn')
    saveConfig(nested, DEFAULT_CONFIG)
    expect(loadConfig(nested).config).toEqual(DEFAULT_CONFIG)
  })

  it('writes exactly the four schema keys and nothing derived from the clipboard', () => {
    saveConfig(dir, DEFAULT_CONFIG)
    const raw = JSON.parse(readFileSync(configPath(dir), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['accelerator', 'firstRunHotkeyDone', 'retention', 'version'])
  })
})
