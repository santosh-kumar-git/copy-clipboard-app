import sharp from 'sharp'
import { THUMBNAIL_JPEG_QUALITY, THUMBNAIL_MAX_BYTES, THUMBNAIL_MAX_EDGE_PX } from '@cairn/protocol'

/** [longest edge px, JPEG quality]. Walked in order until the output fits THUMBNAIL_MAX_BYTES. */
const LADDER: readonly (readonly [number, number])[] = [
  [THUMBNAIL_MAX_EDGE_PX, THUMBNAIL_JPEG_QUALITY],
  [THUMBNAIL_MAX_EDGE_PX, 50],
  [THUMBNAIL_MAX_EDGE_PX, 35],
  [THUMBNAIL_MAX_EDGE_PX, 20],
  [THUMBNAIL_MAX_EDGE_PX / 2, 50],
]

/**
 * A list-row thumbnail, generated ONCE at capture so no phone ever pulls a 5 MB PNG to draw a row.
 * Buffer in, Buffer out: sharp touches no file, which is what keeps spec §11 control 1 true.
 */
export async function thumbnail(png: Uint8Array): Promise<Uint8Array> {
  let smallest: Buffer | null = null
  for (const [edge, quality] of LADDER) {
    const out = await sharp(png)
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer()
    if (out.length <= THUMBNAIL_MAX_BYTES) return out
    smallest = out
  }
  throw new Error(`thumbnail: cannot fit under ${THUMBNAIL_MAX_BYTES} bytes; smallest was ${smallest?.length ?? -1}`)
}
