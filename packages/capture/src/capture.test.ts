import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createTestClock, fixturePath, type Candidate } from '@cairn/protocol'
import * as privacy from '@cairn/privacy'
import { createCapture, defaultCaptureConfig } from './capture'
import { createStubAgent } from './stub-agent'
import { changed, createSpyLogger, rep } from './testing'
import { createFakeAgent } from '@cairn/agent-host'

const setup = () => {
  const clock = createTestClock()
  const agent = createStubAgent()
  const { logger, events } = createSpyLogger()
  const got: Candidate[] = []
  const capture = createCapture({
    agent, privacy, config: defaultCaptureConfig(privacy.DEFAULT_RULES), clock, logger,
  })
  capture.onCandidate((c) => { got.push(c) })
  return { clock, agent, capture, got, events }
}

describe('capture', () => {
  it('debounces two changes 40 ms apart into ONE candidate carrying the later text', async () => {
    const { clock, agent, capture, got } = setup()
    await capture.start()
    agent.emitChanged(changed(365, [rep('text/plain', 'public.utf8-plain-text', 'second copy')]))
    clock.advance(40)
    agent.emitChanged(changed(366, [rep('text/plain', 'public.utf8-plain-text', 'third copy')]))
    clock.advance(700)
    await capture.whenIdle()
    expect(got).toHaveLength(1)
    expect(got[0]?.primaryText).toBe('third copy')
    expect(got[0]?.changeToken).toBe('366')
  })

  it('ignores exactly the suppressed token and still records the next change', async () => {
    const { clock, agent, capture, got } = setup()
    await capture.start()
    const res = await agent.request('write', { reps: [], transient: true })
    expect(res.ok).toBe(true)
    if (res.ok) capture.suppressToken(String(res.value.changeToken))
    agent.emitChanged(changed(999, [rep('text/plain', 'public.utf8-plain-text', 'our own write')]))
    clock.advance(700)
    await capture.whenIdle()
    expect(got).toHaveLength(0)
    agent.emitChanged(changed(1000, [rep('text/plain', 'public.utf8-plain-text', 'typed by hand')]))
    clock.advance(700)
    await capture.whenIdle()
    expect(got.map((c) => c.primaryText)).toEqual(['typed by hand'])
  })

  it('emits two candidates with the SAME contentHash for the same text copied twice', async () => {
    const { clock, agent, capture, got } = setup()
    await capture.start()
    agent.emitChanged(changed(370, [rep('text/plain', 'public.utf8-plain-text', 'hello world')]))
    clock.advance(700)
    await capture.whenIdle()
    agent.emitChanged(changed(371, [rep('text/plain', 'public.utf8-plain-text', 'hello world')]))
    clock.advance(700)
    await capture.whenIdle()
    // Two candidates on purpose: @cairn/history collapses these into one row with a bumped
    // updatedAt. If capture swallowed the second, recency could never bump.
    expect(got).toHaveLength(2)
    expect(got[0]?.contentHash).toBe(got[1]?.contentHash)
    expect(got[1]!.capturedAt).toBeGreaterThan(got[0]!.capturedAt)
  })

  it('skips a concealed change BEFORE reading a byte: no candidate and no thumbnail', async () => {
    const { clock, agent, capture, got, events } = setup()
    await capture.start()
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()
    agent.emitChanged(changed(380, [rep('image/png', 'public.png', png)], ['concealed']))
    clock.advance(700)
    await capture.whenIdle()
    expect(got).toHaveLength(0)
    expect(events).toContain('privacy.skipped')
    expect(events).not.toContain('capture.thumbnail')
  })

  it('hands on a MASKED preview for a secret, never the raw value', async () => {
    const { clock, agent, capture, got } = setup()
    await capture.start()
    agent.emitChanged(changed(390, [rep('text/plain', 'public.utf8-plain-text', 'AKIA2E0PQIN4XA7QD')]))
    clock.advance(700)
    await capture.whenIdle()
    expect(got).toHaveLength(1)
    expect(got[0]?.primaryText).toBe('AKIA••••A7QD')
    expect(got[0]?.primaryText).not.toContain('AKIA2E0PQIN4XA7QD')
  })

  it('thumbnails an image candidate under the 24 KiB ceiling', async () => {
    const { clock, agent, capture, got } = setup()
    await capture.start()
    const png = await sharp({ create: { width: 640, height: 400, channels: 3, background: { r: 9, g: 40, b: 200 } } }).png().toBuffer()
    agent.emitChanged(changed(400, [rep('image/png', 'public.png', png)]))
    clock.advance(700)
    await capture.whenIdle()
    expect(got).toHaveLength(1)
    expect(got[0]?.kind).toBe('image')
    expect(got[0]!.thumbnailJpeg!.length).toBeLessThanOrEqual(24 * 1024)
  })

  it('recovers queued and later captures after a malformed PNG without an idle waiter', async () => {
    const { clock, agent, capture, got } = setup()
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()
    await capture.start()
    agent.emitChanged(changed(410, [rep('image/png', 'public.png', png.subarray(0, 8))]))
    clock.advance(700)
    agent.emitChanged(changed(411, [rep('text/plain', 'public.utf8-plain-text', 'queued after malformed PNG')]))
    clock.advance(700)

    // Leave the queue unobserved until it emits, so an unhandled rejection fails the test.
    await vi.waitFor(() => expect(got.map((c) => c.changeToken)).toEqual(['411']))
    await expect(capture.whenIdle()).resolves.toBeUndefined()
    expect(got[0]?.primaryText).toBe('queued after malformed PNG')

    agent.emitChanged(changed(412, [rep('image/png', 'public.png', png)]))
    clock.advance(700)
    agent.emitChanged(changed(413, [rep('text/plain', 'public.utf8-plain-text', 'later text')]))
    clock.advance(700)
    await expect(capture.whenIdle()).resolves.toBeUndefined()
    expect(got.map((c) => c.changeToken)).toEqual(['411', '412', '413'])
    expect(Buffer.from(got[1]!.reps[0]!.bytes)).toEqual(png)
    expect((await sharp(Buffer.from(got[1]!.thumbnailJpeg!)).metadata()).format).toBe('jpeg')
    expect(got[2]?.primaryText).toBe('later text')
    await capture.stop()
  })

  it('resolves whenIdle after a malformed PNG is the only capture', async () => {
    const { clock, agent, capture, got } = setup()
    await capture.start()
    agent.emitChanged(changed(420, [rep('image/png', 'public.png', 'not a PNG')]))
    clock.advance(700)
    await expect(capture.whenIdle()).resolves.toBeUndefined()
    expect(got).toEqual([])
    await capture.stop()
  })

  it('drains queued captures after a malformed PNG on stop while discarding pending changes', async () => {
    const { clock, agent, capture, got } = setup()
    await capture.start()
    agent.emitChanged(changed(430, [rep('image/png', 'public.png', 'not a PNG')]))
    clock.advance(700)
    agent.emitChanged(changed(431, [rep('text/plain', 'public.utf8-plain-text', 'already queued')]))
    clock.advance(700)
    agent.emitChanged(changed(432, [rep('text/plain', 'public.utf8-plain-text', 'still debouncing')]))

    await capture.stop()
    agent.emitChanged(changed(433, [rep('text/plain', 'public.utf8-plain-text', 'after stop')]))
    expect(clock.pending).toBe(0)
    clock.advance(700)
    await expect(capture.whenIdle()).resolves.toBeUndefined()
    expect(got.map((c) => c.changeToken)).toEqual(['431'])
    expect(got[0]?.primaryText).toBe('already queued')
  })
})

const replay = async (name: string) => {
  const clock = createTestClock()
  const { logger, events } = createSpyLogger()
  const agent = createFakeAgent({ transcriptPath: fixturePath('agent-transcripts', name), clock, logger })
  const got: Candidate[] = []
  const capture = createCapture({
    agent, privacy, config: defaultCaptureConfig(privacy.DEFAULT_RULES), clock, logger,
  })
  capture.onCandidate((c) => { got.push(c) })
  await agent.start()
  await capture.start()
  return { agent, capture, clock, got, events }
}

describe('capture, transcript-driven', () => {
  it('duplicate-notify: two ticks at one changeCount produce ONE candidate', async () => {
    const { capture, clock, got } = await replay('duplicate-notify.ndjson')
    clock.advance(700)
    await capture.whenIdle()
    expect(got).toHaveLength(1)
    expect(got[0]?.primaryText).toBe('hello world')
    expect(got[0]?.contentHash).toBe('sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek')
  })

  it('self-write-suppression: our own write is dropped, the next copy is not', async () => {
    const { agent, capture, clock, got, events } = await replay('self-write-suppression.ndjson')
    const res = await agent.request('write', { reps: [{ mime: 'text/plain', uti: null, b64: 'aGVsbG8gd29ybGQ=' }], transient: true })
    expect(res.ok).toBe(true)
    if (res.ok) capture.suppressToken(res.value.changeToken)
    clock.advance(1_200)
    await capture.whenIdle()
    expect(events).toContain('capture.self-write-suppressed')
    expect(got.map((c) => c.primaryText)).toEqual(['typed by hand'])
  })

  it('concealed-1password: nothing is recorded and no byte is read', async () => {
    const { capture, clock, got, events } = await replay('concealed-1password.ndjson')
    clock.advance(700)
    await capture.whenIdle()
    expect(got).toEqual([])
    expect(events).toContain('privacy.skipped')
    expect(events).not.toContain('capture.thumbnail')
    expect(events).not.toContain('capture.candidate')
  })

  it('finder-multifile: kind files, uri-list canonical, hash over the frozen primary rep', async () => {
    const { capture, clock, got } = await replay('finder-multifile.ndjson')
    clock.advance(700)
    await capture.whenIdle()
    expect(got).toHaveLength(1)
    expect(got[0]?.kind).toBe('files')
    expect(got[0]?.reps.map((r) => r.mime)).toEqual(['text/plain', 'text/uri-list'])
    expect(got[0]?.contentHash).toBe('sha256-TMzQkSJCLZ77TIEH0y6EpXef-dooeUO_CpP1EVbQBwA')
    expect(got[0]?.primaryText).toBe('/Users/dev/Documents/report.pdf\n/Users/dev/Documents/notes.txt\n')
  })

  it('chrome-source-url: the rider is dropped so the row hashes like any other copy', async () => {
    const { capture, clock, got } = await replay('chrome-source-url.ndjson')
    clock.advance(700)
    await capture.whenIdle()
    expect(got).toHaveLength(1)
    expect(got[0]?.reps).toHaveLength(1)
    expect(got[0]?.reps[0]?.uti).toBe('public.utf8-plain-text')
    expect(got[0]?.contentHash).toBe('sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek')
  })
})
