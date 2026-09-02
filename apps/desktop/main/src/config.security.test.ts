import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_CANARY } from '@cairn/protocol'
import { configPath, DEFAULT_CONFIG, saveConfig } from './config'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cairn-cfg-sec-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)

describe('config file permissions', () => {
  it('creates the data dir 0700 and the file 0600', () => {
    const dir = join(root, 'Cairn')
    saveConfig(dir, DEFAULT_CONFIG)
    expect(mode(dir)).toBe('700')
    expect(mode(configPath(dir))).toBe('600')
  })

  it('NARROWS a pre-existing world-readable file to 0600', () => {
    // The bug this catches: `writeFileSync(p, d, {mode: 0o600})` leaves an existing 0644 file at
    // 644, so one bad first write makes the config world-readable forever.
    const dir = join(root, 'Cairn')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(configPath(dir), '{}')
    chmodSync(configPath(dir), 0o644)
    expect(mode(configPath(dir))).toBe('644')
    saveConfig(dir, DEFAULT_CONFIG)
    expect(mode(configPath(dir))).toBe('600')
  })

  it('stays 0600 across repeated saves', () => {
    const dir = join(root, 'Cairn')
    saveConfig(dir, DEFAULT_CONFIG)
    saveConfig(dir, { ...DEFAULT_CONFIG, accelerator: 'Cmd+Shift+C' })
    saveConfig(dir, { ...DEFAULT_CONFIG, firstRunHotkeyDone: true })
    expect(mode(configPath(dir))).toBe('600')
  })
})

describe('config file contents', () => {
  it('cannot carry clipboard content: an extra key is stripped by the schema before writing', () => {
    const dir = join(root, 'Cairn')
    saveConfig(dir, { ...DEFAULT_CONFIG, lastCopied: TEST_CANARY } as never)
    const raw = readFileSync(configPath(dir), 'utf8')
    expect(raw).not.toContain(TEST_CANARY)
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual([
      'accelerator', 'firstRunHotkeyDone', 'retention', 'version',
    ])
  })

  it('refuses to write a config that fails its own schema', () => {
    const dir = join(root, 'Cairn')
    expect(() => saveConfig(dir, { ...DEFAULT_CONFIG, accelerator: '' })).toThrow()
  })
})
