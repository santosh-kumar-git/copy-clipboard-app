import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_BUNDLE_ID,
  MAX_TRANSCRIPT_BYTES,
  listTranscripts,
  loadDetector,
  scanTranscript,
} from '../scripts/scan-transcripts.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCANNER = join(REPO_ROOT, 'scripts', 'scan-transcripts.mjs')
const PRIVACY_INDEX = join(REPO_ROOT, 'packages', 'privacy', 'src', 'index.ts')

/**
 * Contract §8, "Transcripts are synthetic": run the four checks of §7 over every committed transcript.
 * This file imports `scanTranscript` from the CLI's own module rather than reimplementing it, so the
 * thing CI runs and the thing this test asserts are one function.
 *
 * `mkdtempSync` and `tmpdir(` appear below, and `security/no-plaintext-on-disk.security.test.ts`
 * (Task 6) bans both identifiers under `packages/**` and `apps/desktop/**` — this file is under
 * `security/`, which that scan does not cover, and every path ending `.test.ts` is exempt there in any
 * case. The bytes written here are the literal string `AKIA2E0PQIN4XA7QD`, never clipboard content.
 */

/** A minimal, valid, clean transcript. Written to a temp dir; never to fixtures/. */
const CLEAN_TRANSCRIPT = [
  '{"v":1,"t":"meta","transcript":"probe","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"written by transcripts-synthetic.security.test.ts"}',
  '{"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}',
  '{"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":364,"hints":[],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":11,"sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","inline":"aGVsbG8gd29ybGQ="}],"frontmostBundleId":"com.apple.TextEdit","frontmostName":"TextEdit","attributionConfidence":"heuristic"}}}',
].join('\n') + '\n'

/**
 * A stand-in for the product's detectors, used only to prove the SCANNER's wiring. The real detectors
 * are asserted in the last test in this file and are the only thing `npm run scan:transcripts` ever
 * uses — this stub can never reach CI's verdict.
 */
const stubDetect = (text: string): readonly string[] =>
  /AKIA[0-9A-Z]{12,}/.test(text) ? ['awsAccessKeyId'] : []

const write = (dir: string, name: string, body: string): string => {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

describe('scripts/scan-transcripts.mjs enforces contract §7', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-scan-'))

  it('reports nothing for a clean synthetic transcript', () => {
    expect(scanTranscript(write(dir, 'clean.ndjson', CLEAN_TRANSCRIPT), stubDetect)).toEqual([])
  })

  it('check 1a: fails a transcript whose first line is not a meta frame', () => {
    const body = CLEAN_TRANSCRIPT.split('\n').slice(1).join('\n')
    expect(scanTranscript(write(dir, 'no-meta.ndjson', body), stubDetect)).toEqual([
      'no-meta.ndjson:1: E_NO_META line 1 is not a meta frame',
    ])
  })

  it('check 1b: fails a transcript whose meta.synthetic is not true', () => {
    const body = CLEAN_TRANSCRIPT.replace('"synthetic":true', '"synthetic":false')
    expect(scanTranscript(write(dir, 'not-synthetic.ndjson', body), stubDetect)).toEqual([
      'not-synthetic.ndjson:1: E_NOT_SYNTHETIC meta.synthetic is false, must be true',
    ])
  })

  it('check 2a: fails a Rep.inline whose decoded bytes trip a detector', () => {
    const planted = Buffer.from('AKIA2E0PQIN4XA7QD').toString('base64')
    const body = CLEAN_TRANSCRIPT.replace('aGVsbG8gd29ybGQ=', planted)
    expect(scanTranscript(write(dir, 'planted-inline.ndjson', body), stubDetect)).toEqual([
      'planted-inline.ndjson:3: E_SECRET rep text/plain inline trips awsAccessKeyId',
    ])
  })

  it('check 2b: fails a rep.chunk.b64 whose decoded bytes trip a detector', () => {
    const planted = Buffer.from('AKIA2E0PQIN4XA7QD').toString('base64')
    const chunk = JSON.stringify({
      dir: 'out',
      line: { v: 1, t: 'ev', event: 'rep.chunk', data: { b64: planted, final: true, repId: 'r1', seq: 0 } },
    })
    const body = CLEAN_TRANSCRIPT + chunk + '\n'
    expect(scanTranscript(write(dir, 'planted-chunk.ndjson', body), stubDetect)).toEqual([
      'planted-chunk.ndjson:4: E_SECRET rep.chunk seq 0 b64 trips awsAccessKeyId',
    ])
  })

  it('check 2c: fails a write request whose b64 trips a detector', () => {
    const planted = Buffer.from('AKIA2E0PQIN4XA7QD').toString('base64')
    const request = JSON.stringify({
      dir: 'in',
      line: {
        v: 1,
        t: 'req',
        id: '*',
        method: 'write',
        params: { reps: [{ mime: 'text/plain', uti: null, b64: planted }], transient: false },
      },
    })
    const body = CLEAN_TRANSCRIPT + request + '\n'
    expect(scanTranscript(write(dir, 'planted-write.ndjson', body), stubDetect)).toEqual([
      'planted-write.ndjson:4: E_SECRET write rep text/plain b64 trips awsAccessKeyId',
    ])
  })

  it('check 3: fails a frontmostBundleId outside the allowlist', () => {
    const body = CLEAN_TRANSCRIPT.replace('com.apple.TextEdit', 'com.evil.Keylogger')
    expect(scanTranscript(write(dir, 'bad-bundle.ndjson', body), stubDetect)).toEqual([
      'bad-bundle.ndjson:3: E_BUNDLE_ID com.evil.Keylogger is not an allowlisted bundle id',
    ])
    for (const allowed of [
      'com.apple.TextEdit',
      'com.apple.finder',
      'com.apple.screencaptureui',
      'com.google.Chrome',
      'com.1password.1password',
      'app.cairn.desktop',
    ]) {
      expect(ALLOWED_BUNDLE_ID.test(allowed), allowed).toBe(true)
    }
    expect(ALLOWED_BUNDLE_ID.test('com.evil.Keylogger')).toBe(false)
    expect(ALLOWED_BUNDLE_ID.test('org.mozilla.firefox')).toBe(false)
  })

  it('check 4: fails a transcript over 512 KiB', () => {
    const chunk = JSON.stringify({
      dir: 'out',
      line: {
        v: 1,
        t: 'ev',
        event: 'rep.chunk',
        data: { b64: 'A'.repeat(600 * 1024), final: true, repId: 'r1', seq: 0 },
      },
    })
    const path = write(dir, 'too-big.ndjson', CLEAN_TRANSCRIPT + chunk + '\n')
    expect(statSync(path).size).toBeGreaterThan(MAX_TRANSCRIPT_BYTES)
    expect(scanTranscript(path, stubDetect)[0]).toMatch(
      /^too-big\.ndjson:0: E_TOO_BIG \d+ bytes is over the 512 KiB limit/,
    )
  })
})

describe('every committed transcript is synthetic and secret-free', () => {
  it("runs the product's own detectors over fixtures/agent-transcripts, or fails closed", async () => {
    let detect: ((text: string) => readonly string[]) | null = null
    try {
      detect = await loadDetector()
    } catch {
      detect = null
    }
    const files = listTranscripts()

    if (detect === null) {
      // @cairn/privacy is Task 7's. Until it exists the scanner must REFUSE to scan rather than
      // report a clean run it never performed, so that is what is asserted here — this branch can
      // never become a silent pass.
      expect(existsSync(PRIVACY_INDEX)).toBe(false)
      if (files.length > 0) {
        const cli = spawnSync(process.execPath, [SCANNER], { encoding: 'utf8' })
        expect(cli.status).toBe(2)
        expect(cli.stderr).toContain('FATAL @cairn/privacy is not available yet')
      }
      return
    }

    expect(files.length).toBeGreaterThan(0)
    const findings = files.flatMap((file) => scanTranscript(file, detect))
    expect(findings).toEqual([])

    // Mutation proof against the real detectors: a planted AWS key in a temp COPY must be caught.
    const dir = mkdtempSync(join(tmpdir(), 'cairn-scan-real-'))
    const source = files[0] as string
    const planted = readFileSync(source, 'utf8').replace(
      '"inline":"aGVsbG8gd29ybGQ="',
      `"inline":"${Buffer.from('AKIA2E0PQIN4XA7QD').toString('base64')}"`,
    )
    const path = join(dir, 'planted.ndjson')
    writeFileSync(path, planted)
    const caught = scanTranscript(path, detect)
    expect(caught.length, `no detector fired on a planted AWS key in ${source}`).toBeGreaterThan(0)
    expect(caught[0]).toContain('E_SECRET')
  })
})
