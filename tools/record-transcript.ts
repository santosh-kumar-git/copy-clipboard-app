/**
 * Captures a real macOS pasteboard session into a replayable transcript, and diffs a recording
 * against a committed fixture so you can see whether the real binary still emits what the fixture
 * claims.
 *
 * `record` writes REAL clipboard data, in the clear, to fixtures/agent-transcripts/<name>.raw.ndjson.
 * That file is gitignored, is never committed, and should be deleted as soon as you have looked at
 * it. Nothing in the shipping app ever writes clipboard bytes to disk (spec §11 control 1); this is a
 * developer tool and it is deliberately loud about the difference.
 *
 * There is deliberately NO `promote` subcommand and no code path in this file that writes a
 * `*.ndjson` fixture. Every fixture under fixtures/agent-transcripts/ is owned by another task —
 * hello-watch-text and image-tiff-chunked by Task 3, the five capture fixtures by Task 7 — and each of
 * those tasks asserts its fixtures' exact frame counts, byte lengths and hashes. An earlier revision
 * of this tool promoted recordings over them and silently broke those assertions. `diff` is the
 * replacement: it reads, compares and reports, and it never writes anything but the .raw.ndjson.
 *
 *   node tools/record-transcript.ts record my-session 20 --i-understand-this-writes-real-clipboard-data-to-disk
 *   node tools/record-transcript.ts diff my-session hello-watch-text
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AGENT_BIN = join(REPO_ROOT, 'agents', 'macos', 'build', 'cairn-agent-macos')
const TRANSCRIPT_DIR = join(REPO_ROOT, 'fixtures', 'agent-transcripts')
const ACK = '--i-understand-this-writes-real-clipboard-data-to-disk'

interface Frame {
  dir: 'in' | 'out'
  delayMs?: number
  line: Record<string, unknown>
}

function die(message: string): never {
  console.error('record-transcript: ' + message)
  process.exit(2)
}

async function record(name: string, seconds: number, argv: string[]): Promise<void> {
  if (!argv.includes(ACK)) {
    die(
      `refusing to record without ${ACK}\n` +
        '  A raw recording is REAL clipboard data in plaintext on disk. It is gitignored, it is\n' +
        '  never committed, and you delete it as soon as you have looked at it.',
    )
  }
  if (!existsSync(AGENT_BIN)) die(`no agent binary at ${AGENT_BIN} — run \`make agent\` first`)
  const out = join(TRANSCRIPT_DIR, `${name}.raw.ndjson`)
  if (!out.endsWith('.raw.ndjson')) die('refusing to write anywhere but *.raw.ndjson')

  writeFileSync(
    out,
    JSON.stringify({
      v: 1,
      t: 'meta',
      transcript: name,
      recordedOn: `macos ${release()} ${arch()}`,
      synthetic: false,
      note: 'UNSCRUBBED RAW CAPTURE - real clipboard data, never commit this file',
    }) + '\n',
    { mode: 0o600 },
  )
  console.error(
    `record-transcript: writing ${out}\n  This file contains REAL clipboard data. Delete it when you are done.`,
  )

  const startedAt = Date.now()
  const child = spawn(AGENT_BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  const frame = (f: Frame): void => appendFileSync(out, JSON.stringify(f) + '\n')

  let idCounter = 0
  let pendingResponse: (() => void) | null = null

  /**
   * A transcript replays strictly in file order, so the `in` frame for request N+1 must never be
   * written before the `out` frame carrying the response to request N. Hence the await.
   */
  const send = (method: string, params: Record<string, unknown>): Promise<void> => {
    const line = { v: 1, t: 'req', id: '*', method, params }
    frame({ dir: 'in', line })
    child.stdin.write(JSON.stringify({ ...line, id: String(++idCounter) }) + '\n')
    return new Promise((resolve) => {
      pendingResponse = resolve
    })
  }

  let buf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      const raw = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (raw.length === 0) continue
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.t === 'res') parsed.id = '*'      // the host allocates ids; a fixture must not pin them
      frame({ dir: 'out', line: parsed })
      const label = parsed.t === 'ev' ? String(parsed.event) : 'res'
      console.error(`  <- ${label} ${raw.length} bytes @${Date.now() - startedAt}ms`)
      if (parsed.t === 'res' && pendingResponse !== null) {
        const resolve = pendingResponse
        pendingResponse = null
        resolve()
      }
    }
  })

  await send('hello', { hostVersion: '0.1.0' })
  await send('watch.start', { intervalMs: 500 })
  console.error(`record-transcript: recording for ${seconds}s — copy something now`)
  await new Promise((r) => setTimeout(r, seconds * 1000))
  await send('shutdown', {})
  child.kill()
  console.error(
    `record-transcript: done. Next:\n` +
      `  node tools/record-transcript.ts diff ${name} <fixture-name>\n` +
      `  rm fixtures/agent-transcripts/${name}.raw.ndjson`,
  )
}

/**
 * A comparable summary of one transcript frame: direction, method or event name, and for each rep the
 * tuple that has to be stable for the host to behave the same way. Everything that legitimately
 * differs between a live recording and a committed fixture — `id`, `changeCount`, `delayMs`, the
 * frontmost app, the platform version, `repId`, and the inline bytes themselves — is left out, because
 * the point of `diff` is "does the real binary still produce this SHAPE?", not "are the files equal".
 */
function summarise(frame: Record<string, any>): string {
  const line = frame.line as Record<string, any>
  const dir = String(frame.dir)
  if (line.t === 'req') return `${dir} req ${String(line.method)}`
  if (line.t === 'ev') {
    const event = String(line.event)
    if (event === 'rep.chunk') return `${dir} ev rep.chunk final=${String(line.data.final)}`
    const reps = (line.data?.reps ?? []) as Record<string, any>[]
    const hints = (line.data?.hints ?? []) as string[]
    return `${dir} ev ${event} hints=[${hints.join(',')}] reps=[${reps.map(summariseRep).join(' ')}]`
  }
  if (line.t === 'res') {
    if (line.ok === false) return `${dir} res error ${String(line.error?.code)}`
    const result = (line.result ?? {}) as Record<string, any>
    const reps = (result.reps ?? []) as Record<string, any>[]
    const keys = Object.keys(result).sort().join(',')
    return reps.length === 0
      ? `${dir} res ok {${keys}}`
      : `${dir} res ok {${keys}} reps=[${reps.map(summariseRep).join(' ')}]`
  }
  return `${dir} ${String(line.t)}`
}

function summariseRep(rep: Record<string, any>): string {
  const carriage = rep.inline === undefined ? 'streamed' : 'inline'
  return `${String(rep.mime)}|${String(rep.uti)}|${String(rep.byteLength)}|${carriage}`
}

/**
 * Compares a raw recording against a COMMITTED fixture and reports. Writes nothing: every fixture
 * belongs to another task.
 *
 * The fixture is the contract, so the check is PREFIX containment, not equality: every frame the
 * fixture scripts must appear, in order, with the same shape, at the same position in the recording.
 * A live session legitimately runs longer than a fixture models — the recorder always sends `shutdown`
 * and the fixtures do not script it — so trailing recorded frames are reported as information rather
 * than as findings. A fixture that is LONGER than the recording is a finding, because then the agent
 * failed to emit something the fixture claims.
 *
 * Exit 0 = every scripted frame matched. Exit 1 = at least one did not.
 */
function diff(rawName: string, fixtureName: string): void {
  const src = join(TRANSCRIPT_DIR, `${rawName}.raw.ndjson`)
  const fixture = join(TRANSCRIPT_DIR, `${fixtureName}.ndjson`)
  if (!existsSync(src)) die(`no such raw recording: ${src}`)
  if (!existsSync(fixture)) die(`no such committed fixture: ${fixture}`)

  const frames = (path: string): string[] =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, any>)
      .filter((o) => o.t !== 'meta')
      // log frames are recording noise and are not present in any committed fixture
      .filter((o) => !(o.line?.t === 'ev' && o.line?.event === 'log'))
      .map(summarise)

  const recorded = frames(src)
  const committed = frames(fixture)
  let findings = 0
  for (const [i, expected] of committed.entries()) {
    if (recorded[i] === expected) continue
    findings += 1
    console.error(
      `record-transcript: frame ${i + 1} differs\n` +
        `  recorded:  ${recorded[i] ?? '<recording ended early>'}\n` +
        `  committed: ${expected}`,
    )
  }
  const extra = recorded.length - committed.length
  if (findings === 0) {
    console.error(
      `record-transcript: all ${committed.length} scripted frames of ${fixtureName}.ndjson match — ` +
        'the real binary still emits the shape that fixture claims',
    )
    if (extra > 0) {
      console.error(
        `  (${extra} further recorded frame(s) the fixture does not script, which is normal: the\n` +
          '   recorder always sends shutdown and no fixture models it)',
      )
      for (const line of recorded.slice(committed.length)) console.error(`   + ${line}`)
    }
    return
  }
  console.error(
    `record-transcript: ${findings} differing frame(s). The fixture belongs to another task: do NOT\n` +
      '  overwrite it. Either the agent changed and that task must be told, or the recording captured\n' +
      '  something the fixture never modelled.',
  )
  process.exit(1)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'record') {
  await record(rest[0] ?? die('record needs a name'), Number(rest[1] ?? 20), rest)
} else if (cmd === 'diff') {
  diff(rest[0] ?? die('diff needs a raw name'), rest[1] ?? die('diff needs a fixture name'))
} else {
  die(
    'usage:\n' +
      `  record <name> <seconds> ${ACK}\n` +
      '  diff <raw-name> <fixture-name>\n' +
      '\n' +
      '  There is no promote subcommand. Every fixture under fixtures/agent-transcripts/ is owned by\n' +
      '  Task 3 or Task 7, and this tool never writes one.',
  )
}
