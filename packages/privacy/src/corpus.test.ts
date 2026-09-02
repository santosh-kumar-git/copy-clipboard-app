import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixturePath, type DetectorName } from '@cairn/protocol'
import { ALL_DETECTORS, detectSpans } from './detectors'

const read = (n: string): string => readFileSync(fixturePath('secrets', n), 'utf8')
const FALSE_POSITIVES = JSON.parse(read('false-positive-corpus.json')) as Record<string, string>
type CorpusEntry = { key: string; detector: DetectorName; text?: string; textParts?: string[] }
// `textParts` exists so no literal partner-scanned secret pattern is committed — a literal one makes
// GitHub push protection reject the push. Join here, once, so no test needs to care.
const TRUE_POSITIVES = (JSON.parse(read('detector-corpus.json')) as CorpusEntry[]).map((e) => ({
  ...e,
  text: e.text ?? (e.textParts ?? []).join(''),
}))

describe('secret corpora', () => {
  it('has exactly the 13 frozen false-positive cases', () => {
    expect(Object.keys(FALSE_POSITIVES)).toHaveLength(13)
  })

  it.each(Object.entries(FALSE_POSITIVES))('does NOT trip on %s', (_key, text) => {
    expect(detectSpans(text, ALL_DETECTORS)).toEqual([])
  })

  it('covers every one of the ten detectors', () => {
    expect(new Set(TRUE_POSITIVES.map((e) => e.detector))).toEqual(new Set(ALL_DETECTORS))
  })

  it.each(TRUE_POSITIVES.map((e) => [e.key, e.detector, e.text] as const))(
    'trips %s with detector %s',
    (_key, detector, text) => {
      expect(detectSpans(text, ALL_DETECTORS).map((s) => s.detector)).toContain(detector)
    },
  )
})
