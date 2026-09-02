import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { THUMBNAIL_MAX_BYTES, THUMBNAIL_MAX_EDGE_PX, fixturePath } from '@cairn/protocol'
import { thumbnail } from './thumbnail'

describe('thumbnail', () => {
  it('emits JPEG with the longest edge at 256 px', async () => {
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 20, g: 90, b: 160 } } }).png().toBuffer()
    const meta = await sharp(Buffer.from(await thumbnail(png))).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(THUMBNAIL_MAX_EDGE_PX)
    expect(meta.height).toBe(171)
  })

  it('never enlarges a small image', async () => {
    const png = readFileSync(fixturePath('formats', 'screenshot.png'))
    const meta = await sharp(Buffer.from(await thumbnail(png))).metadata()
    expect([meta.width, meta.height]).toEqual([64, 40])
  })

  it('stays under 24 KiB for the pathological case: 256x256 of pure noise', async () => {
    const noise = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer()
    const q70 = await sharp(noise).resize({ width: 256, height: 256, fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()
    expect(q70.length).toBeGreaterThan(THUMBNAIL_MAX_BYTES)      // ~34.8 KiB: the naive encode overflows
    const out = await thumbnail(noise)
    expect(out.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES)
  })

  it('rejects bytes that are not an image, rather than writing anything', async () => {
    await expect(thumbnail(Buffer.from('not an image at all', 'utf8')))
      .rejects.toThrow('Input buffer contains unsupported image format')
  })
})
