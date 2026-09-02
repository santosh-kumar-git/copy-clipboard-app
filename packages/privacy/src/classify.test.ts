import { describe, expect, it } from 'vitest'
import { contentHash, type PasteboardHint, type Snapshot, type SourceApp } from '@cairn/protocol'
import { DEFAULT_RULES, SKIP_HINTS, classify, shouldSkipOnHints } from './classify'

const snap = (text: string | null, hints: readonly PasteboardHint[] = [], sourceApp: SourceApp | null = null): Snapshot => {
  const bytes = Buffer.from(text ?? '', 'utf8')
  return {
    reps: [{ mime: 'text/plain', uti: 'public.utf8-plain-text', bytes, byteLength: bytes.length, sha256: contentHash(bytes) }],
    primaryText: text, kind: 'text', hints, sourceApp, totalBytes: bytes.length,
  }
}

describe('classify layer 1 — OS hints, before any byte is read', () => {
  it('skips a concealed pasteboard and flags it concealed', () => {
    expect(classify(snap('hunter2', ['concealed']), DEFAULT_RULES)).toEqual({
      action: 'skip', flags: ['concealed'], reason: 'os-hint',
    })
  })
  it('skips the KDE password-manager hint too', () => {
    expect(classify(snap('hunter2', ['password-manager']), DEFAULT_RULES).action).toBe('skip')
  })
  it('records but flags transient and auto-generated rather than skipping', () => {
    const c = classify(snap('hello world', ['transient', 'auto-generated']), DEFAULT_RULES)
    expect(c.action).toBe('record')
    expect(c.flags).toEqual(['transient', 'auto-generated'])
  })
  it('exposes the same decision as a cheap predicate capture can call before touching bytes', () => {
    expect(shouldSkipOnHints(['concealed'], DEFAULT_RULES)).toBe(true)
    expect(shouldSkipOnHints(['transient'], DEFAULT_RULES)).toBe(false)
    expect(shouldSkipOnHints(['concealed'], { ...DEFAULT_RULES, honourHints: false })).toBe(false)
    expect(SKIP_HINTS).toEqual(['concealed', 'password-manager'])
  })
  it('wins over the detector layer: a concealed AWS key is skipped, not masked', () => {
    expect(classify(snap('AKIA2E0PQIN4XA7QD', ['concealed']), DEFAULT_RULES).flags).toEqual(['concealed'])
  })
})

describe('classify layer 2 — exclusion list, failing closed', () => {
  it('is inert in M1 because excludedBundleIds is empty', () => {
    expect(DEFAULT_RULES.excludedBundleIds).toEqual([])
    expect(classify(snap('hello world', [], null), DEFAULT_RULES).action).toBe('record')
  })
  it('skips when a rule is active and the owner is unknowable', () => {
    const rules = { ...DEFAULT_RULES, excludedBundleIds: ['com.agilebits.onepassword7'] }
    expect(classify(snap('hello world', [], null), rules)).toEqual({
      action: 'skip', flags: ['excluded'], reason: 'owner-unknown-fail-closed',
    })
  })
  it('skips a matching bundle id and records a non-matching one', () => {
    const rules = { ...DEFAULT_RULES, excludedBundleIds: ['com.agilebits.onepassword7'] }
    const app = (bundleId: string): SourceApp => ({ bundleId, name: null, confidence: 'heuristic' })
    expect(classify(snap('hello world', [], app('com.agilebits.onepassword7')), rules).action).toBe('skip')
    expect(classify(snap('hello world', [], app('com.apple.TextEdit')), rules).action).toBe('record')
  })
})

describe('classify layer 3 — detectors', () => {
  it('records a secret rather than dropping it, and names the detectors in the reason', () => {
    const c = classify(snap('AKIA2E0PQIN4XA7QD'), DEFAULT_RULES)
    expect(c.action).toBe('record')
    expect(c.flags).toEqual(['secret'])
    expect(c.reason).toBe('detectors:aws-access-key')
  })
  it('records clean text with no flags at all', () => {
    expect(classify(snap('the quick brown fox'), DEFAULT_RULES)).toEqual({ action: 'record', flags: [], reason: 'clean' })
  })
  it('records an image with no primaryText without inspecting text', () => {
    expect(classify(snap(null), DEFAULT_RULES).flags).toEqual([])
  })
})
