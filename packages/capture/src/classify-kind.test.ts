import { describe, expect, it } from 'vitest'
import { MIME_SOURCE_URL } from '@cairn/protocol'
import { PRIMARY_REP_ORDER, classifyKind, selectPrimaryRep } from './classify-kind'
import { rep } from './testing'

describe('classifyKind', () => {
  it('text: a bare text/plain copy', () => {
    expect(classifyKind([rep('text/plain', 'public.utf8-plain-text', 'hello world')])).toBe('text')
  })
  it('richtext: html WITH a text fallback still reads as richtext', () => {
    expect(classifyKind([
      rep('text/html', 'public.html', '<p>hi</p>'),
      rep('text/plain', 'public.utf8-plain-text', 'hi'),
    ])).toBe('richtext')
  })
  it('richtext: rtf with a text fallback', () => {
    expect(classifyKind([
      rep('text/rtf', 'public.rtf', '{\\rtf1}'),
      rep('text/plain', 'public.utf8-plain-text', 'hi'),
    ])).toBe('richtext')
  })
  it('image: png', () => {
    expect(classifyKind([rep('image/png', 'public.png', 'x')])).toBe('image')
  })
  it('image: jpeg', () => {
    expect(classifyKind([rep('image/jpeg', 'public.jpeg', 'x')])).toBe('image')
  })
  it('files: a Finder copy, even though it also carries the paths as text/plain', () => {
    expect(classifyKind([
      rep('text/uri-list', 'public.file-url', 'file:///a\n'),
      rep('text/plain', 'public.utf8-plain-text', '/a\n'),
    ])).toBe('files')
  })
  it('mixed: a web copy carrying text + html + an image reads as image', () => {
    expect(classifyKind([
      rep('text/plain', 'public.utf8-plain-text', 'hi'),
      rep('text/html', 'public.html', '<p>hi</p>'),
      rep('image/png', 'public.png', 'x'),
    ])).toBe('image')
  })
  it('a text/x-source-url rider is text, never files', () => {
    // Chrome's org.chromium.source-url rider carries a URL. normalizeReps drops it long before
    // this runs, but if it ever survives it must not turn a copied paragraph into a file row.
    expect(classifyKind([rep(MIME_SOURCE_URL, 'org.chromium.source-url', 'https://example.com/a')])).toBe('text')
    expect(classifyKind([
      rep('text/plain', 'public.utf8-plain-text', 'hello world'),
      rep(MIME_SOURCE_URL, 'org.chromium.source-url', 'https://example.com/a'),
    ])).toBe('text')
  })
  it('unknown mimes fall back to text rather than throwing', () => {
    expect(classifyKind([rep('application/octet-stream', null, 'x')])).toBe('text')
    expect(classifyKind([])).toBe('text')
  })
})

describe('selectPrimaryRep', () => {
  it('follows the frozen order', () => {
    expect(PRIMARY_REP_ORDER).toEqual(['text/plain', 'text/uri-list', 'image/png', 'text/html', 'text/rtf'])
  })
  it('prefers text/plain over everything, so two machines hash the same copy identically', () => {
    expect(selectPrimaryRep([
      rep('image/png', 'public.png', 'x'),
      rep('text/plain', 'public.utf8-plain-text', 'hello world'),
    ])?.mime).toBe('text/plain')
  })
  it('falls through to the first remaining rep for an unlisted mime', () => {
    expect(selectPrimaryRep([rep('application/pdf', 'com.adobe.pdf', 'x')])?.mime).toBe('application/pdf')
  })
  it('returns null for an empty rep set', () => {
    expect(selectPrimaryRep([])).toBeNull()
  })
})
