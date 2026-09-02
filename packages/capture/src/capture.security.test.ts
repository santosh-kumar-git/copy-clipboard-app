import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { TEST_CANARY, createTestClock, type Candidate } from '@cairn/protocol'
import * as privacy from '@cairn/privacy'
import { createCapture, defaultCaptureConfig } from './capture'
import { createStubAgent } from './stub-agent'
import { changed, createSpyLogger, rep } from './testing'

const WRITE_SURFACE = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
  'open', 'openSync', 'mkdtemp', 'mkdtempSync', 'writeSync', 'write',
] as const

const build = () => {
  const clock = createTestClock()
  const agent = createStubAgent()
  const { logger } = createSpyLogger()
  const got: Candidate[] = []
  const capture = createCapture({
    agent, privacy, config: defaultCaptureConfig(privacy.DEFAULT_RULES), clock, logger,
  })
  capture.onCandidate((c) => { got.push(c) })
  return { clock, agent, capture, got }
}

describe('capture writes nothing to disk', () => {
  it('calls no fs write API during a text + image capture', async () => {
    const spies = WRITE_SURFACE.map((n) => vi.spyOn(fs, n as 'writeFileSync'))
    const pspies = (['writeFile', 'appendFile', 'mkdtemp', 'open'] as const).map((n) => vi.spyOn(fsp, n))
    const { clock, agent, capture } = build()
    await capture.start()
    const png = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 7, g: 7, b: 7 } } }).png().toBuffer()
    agent.emitChanged(changed(500, [rep('text/plain', 'public.utf8-plain-text', TEST_CANARY)]))
    clock.advance(150); await capture.whenIdle()
    agent.emitChanged(changed(501, [rep('image/png', 'public.png', png)]))
    clock.advance(150); await capture.whenIdle()
    for (const s of [...spies, ...pspies]) expect(s).not.toHaveBeenCalled()
    for (const s of [...spies, ...pspies]) s.mockRestore()
  })

  it('creates no new file under TMPDIR while capturing a 200 KB payload', async () => {
    // TMPDIR is redirected to a private empty directory for the duration. Reading the SHARED temp
    // dir here would be flaky rather than strict: other vitest workers create store fixtures in it
    // concurrently, so a before/after diff picks up their directories and fails for the wrong
    // reason. `os.tmpdir()` re-reads $TMPDIR on every call, so this keeps the assertion exact —
    // the private dir must end up completely empty.
    const sandbox = fs.mkdtempSync(`${tmpdir()}/cairn-tmp-sandbox-`)
    const prevTmp = process.env.TMPDIR
    process.env.TMPDIR = sandbox
    try {
      const { clock, agent, capture } = build()
      await capture.start()
      agent.emitChanged(changed(600, [rep('text/plain', 'public.utf8-plain-text', `${TEST_CANARY} ${'x'.repeat(200_000)}`)]))
      clock.advance(150); await capture.whenIdle()
      const created = fs.readdirSync(sandbox)
      expect(created).toEqual([])
      for (const name of created) {
        expect(fs.readFileSync(`${sandbox}/${name}`).includes(TEST_CANARY)).toBe(false)
      }
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = prevTmp
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('captures fine with TMPDIR pointed at a 0500 dir, and that dir stays empty', async () => {
    const ro = fs.mkdtempSync(`${tmpdir()}/cairn-ro-`)
    const prev = process.env.TMPDIR
    fs.chmodSync(ro, 0o500)
    process.env.TMPDIR = ro
    try {
      const { clock, agent, capture, got } = build()
      await capture.start()
      const png = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 3, g: 9, b: 27 } } }).png().toBuffer()
      agent.emitChanged(changed(700, [rep('image/png', 'public.png', png)]))
      clock.advance(150); await capture.whenIdle()
      expect(got).toHaveLength(1)
      expect(fs.readdirSync(ro)).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = prev
      fs.chmodSync(ro, 0o700)
      fs.rmSync(ro, { recursive: true, force: true })
    }
  })
})
