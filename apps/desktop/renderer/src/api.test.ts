import { describe, expect, it } from 'vitest'
import {
  THUMBNAIL_DATA_URL_PREFIX,
  parseHistoryChanged,
  parseHotkeyStatus,
  parsePaletteShown,
  parseToast,
  safeThumbnailSrc,
} from './api'

// Spec §11 control 8: IPC is validated in BOTH directions. Main validates what the renderer sends;
// these guards are the renderer's half, so a malformed event can never reach component state.
describe('event payload guards', () => {
  it('accepts a well-formed payload of each kind', () => {
    expect(parseHistoryChanged({ reason: 'ingest', total: 3 })).toEqual({ reason: 'ingest', total: 3 })
    expect(parseHotkeyStatus({ status: 'failed', accelerator: 'Cmd+Shift+V' })).toEqual({
      status: 'failed',
      accelerator: 'Cmd+Shift+V',
    })
    expect(parseToast({ text: 'Copied', tone: 'warn' })).toEqual({ text: 'Copied', tone: 'warn' })
    expect(parsePaletteShown({ shownAt: 1_767_225_600_000 })).toEqual({ shownAt: 1_767_225_600_000 })
  })

  it('rejects a bad discriminator instead of passing it through', () => {
    expect(parseHistoryChanged({ reason: 'exploded', total: 3 })).toBe(null)
    expect(parseHotkeyStatus({ status: 'exploded', accelerator: 'x' })).toBe(null)
    expect(parseToast({ text: 'hi', tone: 'shout' })).toBe(null)
  })

  it('rejects wrong primitive types and non-objects', () => {
    expect(parseHistoryChanged({ reason: 'ingest', total: '3' })).toBe(null)
    expect(parseHistoryChanged({ reason: 'ingest', total: -1 })).toBe(null)
    expect(parseHistoryChanged({ reason: 'ingest', total: 1.5 })).toBe(null)
    expect(parsePaletteShown({ shownAt: 'yesterday' })).toBe(null)
    expect(parseToast('not an object')).toBe(null)
    expect(parseToast(null)).toBe(null)
    expect(parseToast([{ text: 'hi', tone: 'info' }])).toBe(null)
  })

  it('rejects an over-long toast, matching the 200-char cap in the IPC schema', () => {
    expect(parseToast({ text: 'x'.repeat(200), tone: 'info' })?.text.length).toBe(200)
    expect(parseToast({ text: 'x'.repeat(201), tone: 'info' })).toBe(null)
    expect(parseToast({ text: '', tone: 'info' })).toBe(null)
  })
})

// The one place a string from the store reaches an <img src>. Anything but a JPEG data URL is
// dropped, so no copied item can name a scheme or a type we did not intend to render.
describe('safeThumbnailSrc', () => {
  it('passes a JPEG data URL through unchanged', () => {
    const src = `${THUMBNAIL_DATA_URL_PREFIX}/9j/4AAQSkZJRg==`
    expect(safeThumbnailSrc(src)).toBe(src)
  })

  it('drops anything that is not a JPEG data URL', () => {
    expect(safeThumbnailSrc(null)).toBe(null)
    expect(safeThumbnailSrc('data:image/svg+xml;base64,PHN2Zy8+')).toBe(null)
    expect(safeThumbnailSrc('javascript:alert(1)')).toBe(null)
    expect(safeThumbnailSrc('https://example.com/a.jpg')).toBe(null)
    expect(safeThumbnailSrc(`${THUMBNAIL_DATA_URL_PREFIX}${'A'.repeat(64 * 1024)}`)).toBe(null)
  })
})
