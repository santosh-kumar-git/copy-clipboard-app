/**
 * Spec §11 control 1, contract §8: clipboard bytes NEVER touch the disk unencrypted — no spool
 * file, no temp file, no plaintext cache. This file is the repo-wide layer of that control; the
 * per-package layers are `packages/store/src/store.security.test.ts` and, for the process that
 * holds the bytes first, `packages/agent-host/src/spawn-agent.test.ts`.
 *
 * The source scan below covers `packages/**` and `apps/desktop/**` only. `security/**` is
 * deliberately outside those globs, which is why this file spells the banned identifiers out in
 * full instead of assembling them from fragments.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_CANARY, contentHash, type BlobId, type Candidate, type ResolvedRep } from '@cairn/protocol'
import {
  fixedClock,
  itemFixture,
  openStore,
  randomTestKey,
  silentLogger,
  tempStoreDir,
  testItemId,
  type Store,
} from '@cairn/store'
import { REPO_ROOT, findInSources, sourceFiles } from './source-scan'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

/**
 * `REPO_ROOT` is imported rather than recomputed: `security/source-scan.ts` already resolves it as
 * `security/..`, and `findInSources` reports its `file` paths relative to that same value, so the
 * two halves of this test cannot drift. This file never imports `@cairn/protocol`'s `REPO_ROOT`,
 * which resolves the same directory from a different depth.
 */

/** Every FILE under `p`, recursively, never descending into `node_modules`. A missing root is an
 *  empty list, not a throw. Used for the two *data-dir* walks below; the SOURCE walk goes through
 *  `sourceFiles`, which prunes more and is shared with every other source ban. */
function walk(p: string): string[] {
  if (!existsSync(p)) return []
  // `lstatSync`, and REGULAR files only. Every caller below opens what this returns, and opening a
  // FIFO with no writer blocks forever — not an error, so no try/catch helps, and the block is a
  // synchronous syscall so no test timeout can interrupt it. The same shape hung CI from
  // packages/agent-host/src/spawn-agent.test.ts, whose walker scanned $TMPDIR on a runner whose
  // temp directory contains Actions' own FIFOs. This walker only sees directories we create, so it
  // was not the one that hung — it is hardened because it is one `walk(otherDir)` away from being.
  const st = lstatSync(p)
  if (!st.isDirectory()) return st.isFile() ? [p] : []
  return readdirSync(p)
    .filter((f) => f !== 'node_modules')
    .flatMap((f) => walk(join(p, f)))
}

/** The canary, shaped exactly as `@cairn/capture` will hand it to `history.ingest` in Task 8. */
function canaryCandidate(): Candidate {
  const bytes = Buffer.from(`${TEST_CANARY} and a little more text`, 'utf8')
  const rep: ResolvedRep = {
    mime: 'text/plain',
    uti: 'public.utf8-plain-text',
    bytes,
    byteLength: bytes.byteLength,
    sha256: contentHash(bytes),
  }
  return {
    reps: [rep],
    kind: 'text',
    contentHash: rep.sha256,
    primaryText: bytes.toString('utf8'),
    hints: [],
    sourceApp: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', confidence: 'heuristic' },
    thumbnailJpeg: null,
    changeToken: 'change-1',
    capturedAt: 1_767_225_600_000,
  }
}

describe('no plaintext clipboard bytes on disk (spec §11 control 1, contract §8)', () => {
  it('ingests a canary Candidate and leaves it in no byte, no filename and no temp file', async () => {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    const sandboxTmp = join(dir, 'tmp-sandbox')
    mkdirSync(sandboxTmp, { recursive: true, mode: 0o700 })
    const candidate = canaryCandidate()
    const realTmp = tmpdir()

    let store: Store | null = null
    let blobId: BlobId | null = null
    const previousTmpdir = process.env['TMPDIR']
    process.env['TMPDIR'] = sandboxTmp
    try {
      // Every write path the store has, in the order a real ingest uses them: open (meta.json +
      // the anchor CHECKPOINT), one sealed blob per representation, ONE sealed ITEM_ADDED that
      // references them, a checkpoint, then a compaction that rewrites the whole log.
      const opened = openStore({ dir, key: randomTestKey(), clock: fixedClock(), logger: silentLogger })
      if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`)
      store = opened.value
      const rep = candidate.reps[0]
      if (rep === undefined) throw new Error('unreachable')
      const put = store.putBlob(rep.bytes)
      if (!put.ok) throw new Error(put.message)
      blobId = put.value
      const item = itemFixture(testItemId(7), put.value, candidate.primaryText ?? '')
      const appended = store.appendEvent({ kind: 'ITEM_ADDED', item })
      if (!appended.ok) throw new Error(appended.message)
      expect(store.checkpoint(1).ok).toBe(true)
      expect(store.compact([item.id]).ok).toBe(true)
    } finally {
      if (previousTmpdir === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = previousTmpdir
    }
    if (store === null || blobId === null) throw new Error('unreachable')
    cleanups.push(() => store?.close())

    // 1. The private temp dir the whole ingest ran under is still empty: no spool file, no temp
    //    file, under any name.
    expect(walk(sandboxTmp)).toEqual([])

    // 2. The shared temp dir gained nothing that looks like a spool. Its listing is NOT compared
    //    for equality: concurrent vitest workers add and remove their own `cairn-test-*`
    //    directories while this test runs.
    const tmpEntries = readdirSync(realTmp)
    expect(tmpEntries).toContain(basename(dir))
    for (const name of tmpEntries) {
      expect(name.includes(TEST_CANARY), `${name} names the canary`).toBe(false)
      expect(/spool/i.test(name), `${name} looks like a spool file`).toBe(false)
    }

    // 3. Every byte of every file under the data dir. This is the README's claim, mechanised.
    const files = walk(dir)
    expect(files.length).toBeGreaterThanOrEqual(3) // history.ndjson, meta.json, one blob
    const canaryB64 = Buffer.from(TEST_CANARY, 'utf8').toString('base64')
    for (const file of files) {
      const bytes = readFileSync(file)
      expect(bytes.includes(TEST_CANARY), `${file} contains the canary`).toBe(false)
      // An extra tripwire, not the primary control: base64 of the canary means a plaintext body
      // was base64'd into some field.
      expect(bytes.includes(canaryB64), `${file} contains the base64 canary`).toBe(false)
      expect(relative(dir, file).includes(TEST_CANARY), `${file} names the canary`).toBe(false)
    }

    // 4. …and the canary really did go in, so none of the above is vacuous.
    const previews: string[] = []
    for await (const record of store.readAll()) {
      if (record.ok && record.value.kind === 'ITEM_ADDED') previews.push(record.value.item.preview)
    }
    expect(previews.some((p) => p.includes(TEST_CANARY))).toBe(true)
    const body = store.getBlob(blobId)
    expect(body.ok && body.value.toString('utf8')).toBe(candidate.primaryText)
  })

  // The bug that hung CI, pinned here because it is a property of the WALKER, not of the store.
  // `packages/agent-host/src/spawn-agent.test.ts` walked $TMPDIR and opened every non-directory it
  // found. A GitHub macOS runner's temp directory contains FIFOs belonging to the Actions
  // infrastructure; `open()` on a FIFO with no writer never returns. It is not an error, so the
  // try/catch around it never fired, and it is a synchronous syscall, so vitest's per-test timeout
  // could not interrupt it. The worker stopped reporting, vitest kept believing tests were running,
  // and the job hung with no summary and no failure. Local temp directories have no FIFOs, so every
  // local run passed.
  it('skips a FIFO instead of blocking forever in open() — the bug that hung CI', () => {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    const regular = join(dir, 'regular.txt')
    writeFileSync(regular, 'plain text')
    const fifo = join(dir, 'a-fifo')
    execFileSync('/usr/bin/mkfifo', [fifo])
    expect(lstatSync(fifo).isFIFO(), 'the fixture must really be a FIFO').toBe(true)

    const files = walk(dir)
    expect(files).toContain(regular)
    // Asserted BEFORE the read loop on purpose: if this regresses it must fail fast, not hang.
    expect(files, 'a FIFO must never reach a readFileSync').not.toContain(fifo)

    // The property that actually matters: reading everything the walker returns terminates.
    for (const f of files) readFileSync(f)
  })

  it('the scanner itself works: a plaintext file in the same tree IS found', () => {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    writeFileSync(join(dir, 'control.txt'), `leaked: ${TEST_CANARY}`)
    const hits = walk(dir).filter((f) => readFileSync(f).includes(TEST_CANARY))
    expect(hits).toHaveLength(1)
  })

  it('no source file outside @cairn/store mentions a temp-file or file-write identifier', () => {
    /** Contract §8's list, plus the two stream forms Task 3's local guard also bans. */
    const BANNED = [
      'mkdtemp',
      'tmpdir(',
      'os.tmpdir',
      'spool',
      'writeFileSync(',
      'appendFileSync(',
      'createWriteStream(',
    ]
    const WRITES = ['writeFileSync(', 'appendFileSync(', 'createWriteStream(']
    const ROOTS = ['packages', 'apps/desktop']

    /**
     * The allowance list, in full — three boolean clauses in `exempt()`, grouped below as two
     * bullets, and no others. (Contract §8 counts the clauses; this comment groups them.)
     * - any path ending `.test.ts` — a test file builds its own temp dir and writes hostile
     *   fixtures on purpose, which is exactly what keyring's four test files and Task 9's
     *   `config.security.test.ts` do. Granting this here is what lets those tasks drop their
     *   individual exemption requests.
     * - anything under `packages/store/` for the three WRITE identifiers, and the single file
     *   `packages/store/src/testing.ts` for the temp-dir ones: `@cairn/store` is the only package
     *   allowed to write a file at all, and its `tempStoreDir()` is the one temp-dir helper every
     *   other package's tests import instead of rolling their own.
     *
     * Note what is deliberately NOT exempt. `apps/desktop/main/src/config.ts` uses
     * `openSync`/`writeSync`/`fchmodSync` precisely so that it narrows a pre-existing
     * world-readable file, and exempting it here would let that regress silently. And no package —
     * `@cairn/store` included — may reach for a temp directory: `tmpdir(` and `mkdtemp` are banned
     * everywhere outside that one helper.
     */
    const exempt = (file: string, identifier: string): boolean =>
      file.endsWith('.test.ts') ||
      (WRITES.includes(identifier) && file.startsWith('packages/store/')) ||
      file === 'packages/store/src/testing.ts'

    /**
     * `findInSources` returns every NON-COMMENT line under `roots` containing the needle, with
     * `file` already repo-relative and POSIX-separated, and with the RAW line as `text` so a
     * failure message shows what is actually in the file. `sourceFiles` returns absolute paths and
     * has already pruned `node_modules`, `out`, `build`, `coverage`, `.git` and `.vitest-reports`.
     *
     * `.ts` only, both here and in the ban loop: the renderer is sandboxed with no `fs` at all,
     * every Node-side file in the repo is TypeScript, and `sourceFiles`'s extension set is wider —
     * `.ts .js .mjs .cjs .svelte .html .swift .json .plist` — so without this filter the scan would
     * also read `package.json` files and Svelte markup, where none of these identifiers can appear
     * as code. Narrowing here, not in `sourceFiles`, keeps the shared helper unchanged for the
     * other bans that DO want `.svelte` and `.plist`.
     */
    const scanned = sourceFiles(ROOTS)
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .filter((file) => file.endsWith('.ts'))

    // Not vacuous — asserted BEFORE the ban, so a scan that read nothing cannot pass.
    expect(scanned.length).toBeGreaterThan(10)
    expect(scanned).toContain('packages/store/src/blobs.ts')
    expect(scanned).toContain('packages/agent-host/src/reassembler.ts')

    const offenders: string[] = []
    for (const identifier of BANNED) {
      for (const hit of findInSources(identifier, ROOTS)) {
        if (!hit.file.endsWith('.ts')) continue
        if (exempt(hit.file, identifier)) continue
        offenders.push(`${hit.file}:${hit.line}: ${identifier}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
