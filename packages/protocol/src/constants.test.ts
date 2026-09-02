import { describe, expect, it } from 'vitest'
import {
  APP_NAME,
  BUNDLE_ID,
  CHUNK_PAYLOAD_BYTES,
  CHUNK_THRESHOLD_BYTES,
  DATA_DIR_NAME,
  MASK_BULLET,
  MAX_REP_BYTES,
  MIME_SOURCE_URL,
  SECRET_TTL_MS,
  TOAST_COPIED_MANUAL,
  WIRE_MAJOR,
  maskToken,
} from './constants'

describe('constants', () => {
  it('pins the wire major the Swift agent is generated against', () => {
    expect(WIRE_MAJOR).toBe(1)
  })

  it('divides the 20 MiB rep ceiling into exactly 640 chunks, so seq is bounded at 639', () => {
    expect(MAX_REP_BYTES / CHUNK_PAYLOAD_BYTES).toBe(640)
    expect(MAX_REP_BYTES % CHUNK_PAYLOAD_BYTES).toBe(0)
  })

  it('keeps one base64 chunk line under the 64 KiB pipe highWaterMark', () => {
    const b64Chars = Math.ceil(CHUNK_PAYLOAD_BYTES / 3) * 4
    expect(b64Chars).toBe(43_692)
    expect(b64Chars).toBeLessThan(65_536)
  })

  it('streams at or over 64 KiB and inlines below it', () => {
    expect(CHUNK_THRESHOLD_BYTES).toBe(65_536)
  })

  it('expires secrets after five minutes', () => {
    expect(SECRET_TTL_MS).toBe(5 * 60 * 1000)
  })

  it('holds the exact user-visible toast, em dash included', () => {
    expect(TOAST_COPIED_MANUAL).toBe('Copied — press Cmd+V')
  })

  it('names the product in one place', () => {
    expect([APP_NAME, BUNDLE_ID, DATA_DIR_NAME]).toEqual(['Cairn', 'app.cairn.desktop', 'Cairn'])
  })

  it('freezes the mask format the M1 demo shows (contract §5.7)', () => {
    expect(MASK_BULLET).toBe('•')
    expect(maskToken('AKIA2E0PQIN4XA7QD')).toBe('AKIA••••A7QD')
    expect(maskToken('short')).toBe('••••••••')
    expect(maskToken('')).toBe('••••••••')
  })

  it("freezes the mime the agent emits for Chrome's source-url rider", () => {
    expect(MIME_SOURCE_URL).toBe('text/x-source-url')
  })
})
