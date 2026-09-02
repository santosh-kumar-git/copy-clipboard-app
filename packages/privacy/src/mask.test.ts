import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixturePath } from '@cairn/protocol'
import { mask } from './mask'

describe('mask', () => {
  it('produces the exact AKIA••••A7QD preview from the M1 demo, with exact span metadata', () => {
    expect(mask('AKIA2E0PQIN4XA7QD')).toEqual({
      preview: 'AKIA••••A7QD',
      spans: [{ start: 0, end: 17, detector: 'aws-access-key' }],
    })
  })
  it('never leaves the raw secret inside the masked preview', () => {
    const raw = 'AKIA2E0PQIN4XA7QD'
    expect(mask(`export AWS_ACCESS_KEY_ID=${raw}`).preview).not.toContain(raw)
    const gh = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    expect(mask(`token: ${gh}`).preview).not.toContain(gh)
  })
  it('leaves clean text and its offsets completely alone', () => {
    expect(mask('the quick brown fox')).toEqual({ preview: 'the quick brown fox', spans: [] })
  })
  it('masks every secret in a multi-secret paste, with offsets into the RAW text', () => {
    const raw = 'aws AKIA2E0PQIN4XA7QD stripe ' + 'sk_' + 'live_51H8xQwEXAMPLEKEY0123456789'
    const { preview, spans } = mask(raw)
    expect(spans).toEqual([
      { start: 4, end: 21, detector: 'aws-access-key' },
      { start: 29, end: 64, detector: 'stripe-live-key' },
    ])
    expect(raw.slice(4, 21)).toBe('AKIA2E0PQIN4XA7QD')
    expect(raw.slice(29, 64)).toBe('sk_' + 'live_51H8xQwEXAMPLEKEY0123456789')
    expect(preview).toBe('aws AKIA••••A7QD stripe sk_l••••6789')
  })
  it('swallows an overlapping high-entropy run into the specific detector, masking the union', () => {
    const { preview, spans } = mask('AWS_ACCESS_KEY_ID=AKIA2E0PQIN4XA7QD')
    expect(spans).toEqual([{ start: 0, end: 35, detector: 'aws-access-key' }])
    expect(preview).toBe('AWS_••••A7QD')
  })
  it('never produces an all-bullet preview, because no detector can match under 12 chars', () => {
    const corpus = (JSON.parse(readFileSync(fixturePath('secrets', 'detector-corpus.json'), 'utf8')) as
      { text?: string; textParts?: string[] }[]).map((e) => ({ text: e.text ?? (e.textParts ?? []).join('') }))
    for (const { text } of corpus) {
      for (const s of mask(text).spans) expect(s.end - s.start).toBeGreaterThanOrEqual(12)
    }
  })
})
