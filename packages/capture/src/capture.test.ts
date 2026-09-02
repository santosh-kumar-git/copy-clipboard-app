import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { createTestClock, type Candidate } from '@cairn/protocol'
import * as privacy from '@cairn/privacy'
import { createCapture, defaultCaptureConfig } from './capture'
import { createStubAgent } from './stub-agent'
import { changed, createSpyLogger, rep } from './testing'

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
    clock.advance(150)
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
    clock.advance(150)
    await capture.whenIdle()
    expect(got).toHaveLength(0)
    agent.emitChanged(changed(1000, [rep('text/plain', 'public.utf8-plain-text', 'typed by hand')]))
    clock.advance(150)
    await capture.whenIdle()
    expect(got.map((c) => c.primaryText)).toEqual(['typed by hand'])
  })

  it('emits two candidates with the SAME contentHash for the same text copied twice', async () => {
    const { clock, agent, capture, got } = setup()
    await capture.start()
    agent.emitChanged(changed(370, [rep('text/plain', 'public.utf8-plain-text', 'hello world')]))
    clock.advance(150)
    await capture.whenIdle()
    agent.emitChanged(changed(371, [rep('text/plain', 'public.utf8-plain-text', 'hello world')]))
    clock.advance(150)
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
    clock.advance(150)
    await capture.whenIdle()
    expect(got).toHaveLength(0)
    expect(events).toContain('privacy.skipped')
    expect(events).not.toContain('capture.thumbnail')
  })

  it('hands on a MASKED preview for a secret, never the raw value', async () => {
    const { clock, agent, capture, got } = setup()
    await capture.start()
    agent.emitChanged(changed(390, [rep('text/plain', 'public.utf8-plain-text', 'AKIA2E0PQIN4XA7QD')]))
    clock.advance(150)
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
    clock.advance(150)
    await capture.whenIdle()
    expect(got).toHaveLength(1)
    expect(got[0]?.kind).toBe('image')
    expect(got[0]!.thumbnailJpeg!.length).toBeLessThanOrEqual(24 * 1024)
  })
})
