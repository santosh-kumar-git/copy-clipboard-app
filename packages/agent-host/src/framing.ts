import { MAX_LINE_BYTES } from '@cairn/protocol'

export interface LineSplitter {
  /** Feed one raw pipe chunk. Emits every complete line it now holds. */
  push(chunk: Uint8Array): void
  /** Drop everything buffered — used when the child is replaced. */
  reset(): void
  /** Bytes held for an incomplete line. Tests assert this returns to 0. */
  readonly bufferedBytes: number
}

export interface LineSplitterOptions {
  onLine: (line: string) => void
  /** Called ONCE per oversized line, with the byte count that was thrown away. */
  onOverflow: (droppedBytes: number) => void
  maxLineBytes?: number
}

const EMPTY = Buffer.alloc(0)
const LF = 0x0a

/**
 * Byte-level NDJSON splitter. It buffers BYTES and decodes only whole lines, which is what makes a
 * multi-byte UTF-8 character split across two pipe chunks safe.
 */
export function createLineSplitter(opts: LineSplitterOptions): LineSplitter {
  const max = opts.maxLineBytes ?? MAX_LINE_BYTES
  let buf: Buffer = EMPTY
  // True while we are throwing away the tail of a line that already exceeded `max`.
  let discarding = false

  return {
    push(chunk: Uint8Array): void {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, Buffer.from(chunk)])
      for (;;) {
        const nl = buf.indexOf(LF)
        if (nl === -1) break
        const line = buf.subarray(0, nl)
        buf = buf.subarray(nl + 1)
        if (discarding) {
          discarding = false
          continue
        }
        if (line.length > max) {
          opts.onOverflow(line.length)
          continue
        }
        if (line.length > 0) opts.onLine(line.toString('utf8'))
      }
      if (discarding) {
        buf = EMPTY
        return
      }
      if (buf.length > max) {
        // The terminating newline has not arrived and we are already over the cap: report now and
        // discard until it does, so a newline-free stream cannot grow the buffer without limit.
        opts.onOverflow(buf.length)
        buf = EMPTY
        discarding = true
      }
    },
    reset(): void {
      buf = EMPTY
      discarding = false
    },
    get bufferedBytes(): number {
      return buf.length
    },
  }
}
