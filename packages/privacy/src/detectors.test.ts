import { describe, expect, it } from 'vitest'
import type { DetectorName } from '@cairn/protocol'
import { ALL_DETECTORS, detectSpans, mergeSpans } from './detectors'

const names = (t: string): DetectorName[] => [...new Set(detectSpans(t, ALL_DETECTORS).map((s) => s.detector))]

describe('detectors: one positive and one near-miss each', () => {
  it('pem-private-key fires on a BEGIN line and not on a public key or certificate', () => {
    expect(names('-----BEGIN EC PRIVATE KEY-----')).toContain('pem-private-key')
    expect(names('-----BEGIN PUBLIC KEY-----')).not.toContain('pem-private-key')
    expect(names('-----BEGIN CERTIFICATE-----')).not.toContain('pem-private-key')
  })
  it('aws-access-key needs 12+ uppercase chars after AKIA/ASIA', () => {
    expect(names('AKIA2E0PQIN4XA7QD')).toContain('aws-access-key')
    expect(names('ASIA2E0PQIN4XA7QD')).toContain('aws-access-key')
    expect(names('AKIA2E0PQ')).not.toContain('aws-access-key')
    expect(names('akia2e0pqin4xa7qd')).not.toContain('aws-access-key')
  })
  it('github-token fires on ghp_ and github_pat_ but not on a stub', () => {
    expect(names('ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')).toContain('github-token')
    expect(names('github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWX')).toContain('github-token')
    expect(names('ghp_tooshort')).not.toContain('github-token')
  })
  it('openai-key fires on sk- but explicitly not on an sk-ant- key', () => {
    expect(names('sk-proj-Th1sIsNotARealKeyJustFiller99')).toContain('openai-key')
    expect(names('sk-ant-api03-Th1sIsNotARealKeyJustFiller99')).not.toContain('openai-key')
    expect(names('sk-short')).not.toContain('openai-key')
  })
  it('anthropic-key claims the sk-ant- prefix', () => {
    expect(names('sk-ant-api03-Th1sIsNotARealKeyJustFiller99')).toContain('anthropic-key')
    expect(names('sk-ant-tiny')).not.toContain('anthropic-key')
  })
  it('slack-token fires on each of xoxb/xoxa/xoxp/xoxr/xoxs', () => {
    for (const p of ['xoxb', 'xoxa', 'xoxp', 'xoxr', 'xoxs']) {
      expect(names(`${p}-123456789012-abcdefGHIJKL`)).toContain('slack-token')
    }
    expect(names('xoxb-short')).not.toContain('slack-token')
  })
  it('stripe-live-key fires on live secret and restricted keys but never on a test key', () => {
    // Assembled from fragments on purpose — see "Why these strings are split" above.
    const body = '51H8xQwEXAMPLEKEY0123456789'
    expect(names('sk_' + 'live_' + body)).toContain('stripe-live-key')
    expect(names('rk_' + 'live_' + body)).toContain('stripe-live-key')
    expect(names('sk_test_51H8xQwEXAMPLEKEY0123456789')).not.toContain('stripe-live-key')
  })
  it('google-api-key needs exactly 35 chars after AIza', () => {
    expect(names('AIzaSyB1234567890abcdefghijklmnopqrstuv')).toContain('google-api-key')
    expect(names('AIzaSyD-tooShort')).not.toContain('google-api-key')
  })
  it('jwt needs three dot-separated base64url segments', () => {
    expect(names('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toContain('jwt')
    expect(names('eyJhbGciOi.short.x')).not.toContain('jwt')
  })
  it('high-entropy fires on a bare 32-char mixed token', () => {
    expect(names('aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY')).toContain('high-entropy')
  })
  it('honours the enabled-detector list', () => {
    expect(detectSpans('AKIA2E0PQIN4XA7QD', ['jwt'])).toEqual([])
  })
})

describe('mergeSpans', () => {
  it('merges an overlapping high-entropy run into the specific detector that named it', () => {
    expect(mergeSpans([
      { start: 7, end: 42, detector: 'high-entropy' },
      { start: 25, end: 42, detector: 'aws-access-key' },
    ])).toEqual([{ start: 7, end: 42, detector: 'aws-access-key' }])
  })
  it('keeps disjoint spans separate and in offset order', () => {
    expect(mergeSpans([
      { start: 20, end: 30, detector: 'jwt' },
      { start: 0, end: 10, detector: 'high-entropy' },
    ])).toEqual([
      { start: 0, end: 10, detector: 'high-entropy' },
      { start: 20, end: 30, detector: 'jwt' },
    ])
  })
})
