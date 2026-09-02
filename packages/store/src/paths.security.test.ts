import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendLine0600, dataDirLayout, ensureDir0700, writeFile0600 } from './paths'

const mode = (p: string): number => statSync(p).mode & 0o777

describe('data dir layout and permissions (spec §11: 0700 dir, 0600 files)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cairn-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('names every file the store owns', () => {
    expect(dataDirLayout('/data/Cairn')).toEqual({
      dir: '/data/Cairn',
      logPath: '/data/Cairn/history.ndjson',
      tmpLogPath: '/data/Cairn/history.ndjson.tmp',
      metaPath: '/data/Cairn/meta.json',
      keyPath: '/data/Cairn/key.bin',
      blobDir: '/data/Cairn/blobs',
    })
  })

  it('creates every directory 0700, intermediates included', () => {
    const layout = dataDirLayout(join(dir, 'nested', 'Cairn'))
    ensureDir0700(layout.dir)
    ensureDir0700(layout.blobDir)
    expect(mode(join(dir, 'nested'))).toBe(0o700)
    expect(mode(layout.dir)).toBe(0o700)
    expect(mode(layout.blobDir)).toBe(0o700)
  })

  it('writes every file 0600 and does not widen the mode on a second append', () => {
    const layout = dataDirLayout(dir)
    ensureDir0700(layout.dir)
    writeFile0600(layout.metaPath, '{"schemaVersion":1}')
    writeFile0600(layout.keyPath, new Uint8Array([1, 2, 3]))
    appendLine0600(layout.logPath, 'AAAA')
    expect(mode(layout.metaPath)).toBe(0o600)
    expect(mode(layout.keyPath)).toBe(0o600)
    expect(mode(layout.logPath)).toBe(0o600)
    appendLine0600(layout.logPath, 'BBBB')
    expect(mode(layout.logPath)).toBe(0o600)
    expect(readFileSync(layout.logPath, 'utf8')).toBe('AAAA\nBBBB\n')
  })

  it('terminates every appended line with \\n, which is the commit marker', () => {
    const layout = dataDirLayout(dir)
    ensureDir0700(layout.dir)
    appendLine0600(layout.logPath, 'only-line')
    expect(readFileSync(layout.logPath, 'utf8').endsWith('\n')).toBe(true)
    expect(existsSync(layout.tmpLogPath)).toBe(false)
  })

  it('keeps 0700 and 0600 even under a hostile umask, because chmod is not masked', () => {
    // `mkdirSync`'s and `writeFileSync`'s `mode` argument is masked by the process umask: under
    // `umask 0222` a mode-0700 mkdir actually lands at 0500 and a mode-0600 write at 0400. The
    // explicit chmod in paths.ts is the only reason this test passes. The umask is set inside the
    // test, not in the shell, because vite cannot write its own temp files under it.
    const previous = process.umask(0o222)
    try {
      const layout = dataDirLayout(join(dir, 'Cairn'))
      ensureDir0700(layout.dir)
      expect(mode(layout.dir)).toBe(0o700)
      ensureDir0700(layout.blobDir)
      expect(mode(layout.blobDir)).toBe(0o700)
      writeFile0600(layout.metaPath, '{"schemaVersion":1}')
      expect(mode(layout.metaPath)).toBe(0o600)
      appendLine0600(layout.logPath, 'AAAA')
      appendLine0600(layout.logPath, 'BBBB')
      expect(mode(layout.logPath)).toBe(0o600)
    } finally {
      process.umask(previous)
    }
  })
})
