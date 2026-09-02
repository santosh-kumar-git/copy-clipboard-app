/**
 * Contract §7: every committed transcript under fixtures/agent-transcripts/ is SYNTHETIC and
 * secret-free. This is the CI enforcement of that sentence, wired to `npm run scan:transcripts` and
 * chained into `npm run verify`.
 *
 * The four checks, verbatim from the contract. A transcript fails if it:
 *   1. has no meta line, or `meta.synthetic !== true`;
 *   2. contains a `Rep.inline` or a `rep.chunk.b64` whose decoded bytes, interpreted as UTF-8, trip
 *      any detector in `@cairn/privacy` — the SAME code path as the product, so the scan cannot drift;
 *   3. contains a `frontmostBundleId` outside a small allowlist of well-known bundle ids;
 *   4. is over 512 KiB, which is a sign someone committed a real screenshot.
 *
 * `scanTranscript` takes the detector as an argument so
 * security/transcripts-synthetic.security.test.ts runs this exact function rather than a copy of it.
 * The detectors themselves are never reimplemented here: `loadDetector()` imports @cairn/privacy, and
 * if that package is not built yet the CLI exits 2 rather than reporting a clean scan it did not
 * perform.
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = cannot scan.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TRANSCRIPT_DIR = join(REPO_ROOT, 'fixtures', 'agent-transcripts')
export const MAX_TRANSCRIPT_BYTES = 512 * 1024
export const ALLOWED_BUNDLE_ID =
  /^(com\.apple\.[A-Za-z0-9._-]+|com\.google\.Chrome|com\.1password\.1password|app\.cairn\.desktop)$/

/** Every committed transcript, sorted. `*.raw.ndjson` recordings are gitignored and never scanned. */
export function listTranscripts() {
  if (!existsSync(TRANSCRIPT_DIR)) return []
  return readdirSync(TRANSCRIPT_DIR)
    .filter((f) => f.endsWith('.ndjson') && !f.endsWith('.raw.ndjson'))
    .sort()
    .map((f) => join(TRANSCRIPT_DIR, f))
}

/** Every base64 payload one frame can carry, labelled for the failure line. */
function payloadsOf(wire) {
  const out = []
  const reps = wire?.data?.reps ?? wire?.result?.reps ?? []
  for (const rep of reps) {
    if (typeof rep?.inline === 'string') out.push([`rep ${String(rep.mime)} inline`, rep.inline])
  }
  if (wire?.event === 'rep.chunk' && typeof wire?.data?.b64 === 'string') {
    out.push([`rep.chunk seq ${String(wire.data.seq)} b64`, wire.data.b64])
  }
  // An `in` write frame carries the bytes the host asked the agent to put on the pasteboard. The
  // contract names Rep.inline and rep.chunk.b64; scanning this third one too costs nothing and a
  // committed self-write fixture is exactly where a real recalled secret would hide.
  for (const rep of wire?.params?.reps ?? []) {
    if (typeof rep?.b64 === 'string') out.push([`write rep ${String(rep.mime)} b64`, rep.b64])
  }
  return out
}

/**
 * @param {string} path absolute path to a committed *.ndjson transcript
 * @param {(text: string) => readonly string[]} detect names of the detectors that fired, if any
 * @returns {string[]} one named finding per violation; empty means clean
 */
export function scanTranscript(path, detect) {
  const name = basename(path)
  const findings = []
  const add = (line, message) => findings.push(`${name}:${line}: ${message}`)

  const bytes = statSync(path).size
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    add(0, `E_TOO_BIG ${bytes} bytes is over the 512 KiB limit — did someone commit a real screenshot?`)
  }

  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
  let meta = null
  try {
    meta = JSON.parse(lines[0] ?? 'null')
  } catch {
    meta = null
  }
  if (meta === null || meta.t !== 'meta') {
    add(1, 'E_NO_META line 1 is not a meta frame')
  } else if (meta.synthetic !== true) {
    add(1, `E_NOT_SYNTHETIC meta.synthetic is ${JSON.stringify(meta.synthetic)}, must be true`)
  }

  for (const [index, text] of lines.entries()) {
    if (index === 0) continue
    const lineNo = index + 1
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      add(lineNo, 'E_BAD_JSON frame does not parse as JSON')
      continue
    }
    const wire = frame?.line ?? {}
    const bundleId = wire?.data?.frontmostBundleId
    if (typeof bundleId === 'string' && !ALLOWED_BUNDLE_ID.test(bundleId)) {
      add(lineNo, `E_BUNDLE_ID ${bundleId} is not an allowlisted bundle id`)
    }
    for (const [label, b64] of payloadsOf(wire)) {
      const fired = detect(Buffer.from(b64, 'base64').toString('utf8'))
      if (fired.length > 0) add(lineNo, `E_SECRET ${label} trips ${[...fired].join(', ')}`)
    }
  }
  return findings
}

/**
 * The product's own detectors, never a copy of them. Throws if @cairn/privacy has not been built yet
 * (Task 7 owns it) — the caller must fail closed rather than scan with something weaker.
 */
/**
 * Node's ESM resolver has no extension search, but every relative import inside `@cairn/*` is
 * extensionless by contract §2 — vite, vitest and tsc resolve those, plain `node` does not. This is
 * the same hook `tools/gen-agent-types.ts` installs, and for the same reason: it is the only way a
 * plain-Node entry point can load the package source with no build step.
 */
function registerExtensionlessTsResolution() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL !== undefined) {
        const candidate = new URL(`${specifier}.ts`, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

export async function loadDetector() {
  registerExtensionlessTsResolution()
  const { ALL_DETECTORS, detectSpans } = await import('@cairn/privacy')
  if (typeof detectSpans !== 'function' || !Array.isArray(ALL_DETECTORS)) {
    throw new Error('@cairn/privacy does not export detectSpans and ALL_DETECTORS')
  }
  return (text) => [...new Set(detectSpans(text, ALL_DETECTORS).map((span) => span.detector))]
}

export async function main() {
  const files = listTranscripts()
  if (files.length === 0) {
    console.error('scan-transcripts: 0 transcripts under fixtures/agent-transcripts/ — nothing to scan')
    return 0
  }
  let detect
  try {
    detect = await loadDetector()
  } catch (error) {
    console.error(
      `scan-transcripts: FATAL @cairn/privacy is not available yet: ${String(error?.message ?? error)}`,
    )
    console.error(
      `  Refusing to scan ${files.length} transcript(s) with anything other than the product's own\n` +
        '  detectors (contract §7). Build packages/privacy (Task 7) and re-run.',
    )
    return 2
  }
  const findings = files.flatMap((file) => scanTranscript(file, detect))
  for (const finding of findings) console.error(`scan-transcripts: ${finding}`)
  console.error(`scan-transcripts: ${files.length} transcript(s) scanned, ${findings.length} finding(s)`)
  return findings.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main())
