import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { MIME_SOURCE_URL, contentHash, fixturePath } from '@cairn/protocol'
import { canonicaliseUriList, normalizeReps, stripCfHtml } from './normalize-reps'
import { rep } from './testing'

const fx = (n: string): Buffer => readFileSync(fixturePath('formats', n))

describe('normalizeReps', () => {
  it('converts a TIFF rep to a pixel-identical PNG rep and reseals the hash', async () => {
    const out = await normalizeReps([rep('image/tiff', 'public.tiff', fx('screenshot.tiff'))])
    expect(out).toHaveLength(1)
    const png = out[0]!
    expect(png.mime).toBe('image/png')
    expect(png.uti).toBe('public.png')
    expect([...png.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.byteLength).toBe(png.bytes.length)
    expect(png.sha256).toBe(contentHash(png.bytes))
    const got = await sharp(Buffer.from(png.bytes)).raw().toBuffer()
    const want = await sharp(fx('screenshot.png')).raw().toBuffer()
    expect(Buffer.compare(got, want)).toBe(0)
    expect((await sharp(Buffer.from(png.bytes)).metadata()).width).toBe(64)
  })

  it('drops the TIFF entirely when the source app also offered a PNG', async () => {
    const out = await normalizeReps([
      rep('image/tiff', 'public.tiff', fx('screenshot.tiff')),
      rep('image/png', 'public.png', fx('screenshot.png')),
    ])
    expect(out.map((r) => r.mime)).toEqual(['image/png'])
    expect(out[0]!.sha256).toBe(contentHash(fx('screenshot.png')))
  })

  it('strips the CF_HTML wrapper to the exact bytes a Linux copy produces', async () => {
    const out = await normalizeReps([rep('text/html', 'public.html', fx('cf-html-wrapper.txt'))])
    expect(Buffer.from(out[0]!.bytes).toString('utf8')).toBe('<p>Hello <b>bold</b> world</p>')
    expect(out[0]!.sha256).toBe('sha256-DS9cTGJFVDsb2fuiJHH-dgp2PbQSofvQW6e6tAtiFQQ')
    const linux = await normalizeReps([rep('text/html', 'text/html', Buffer.from('<p>Hello <b>bold</b> world</p>', 'utf8'))])
    expect(linux[0]!.sha256).toBe(out[0]!.sha256)
  })

  it('falls back to the first < when the CF_HTML offsets are nonsense', () => {
    const broken = Buffer.from('Version:0.9\r\nStartHTML:9999999999\r\nEndHTML:0000000001\r\n<p>fallback</p>', 'utf8')
    expect(Buffer.from(stripCfHtml(broken)!).toString('utf8')).toBe('<p>fallback</p>')
    expect(stripCfHtml(Buffer.from('<p>bare</p>', 'utf8'))).toBeNull()
  })

  it('canonicalises uri-list: CRLF, comments, blanks and file://localhost all collapse to the fixture', () => {
    const want = fx('uri-list-two-files.txt')
    const dirty = Buffer.from(
      '# a comment\r\nfile://localhost/Users/dev/Documents/report.pdf\r\n\r\nfile:///Users/dev/Documents/notes.txt',
      'utf8',
    )
    expect(Buffer.compare(Buffer.from(canonicaliseUriList(dirty)), want)).toBe(0)
    expect(Buffer.compare(Buffer.from(canonicaliseUriList(want)), want)).toBe(0)
    expect(contentHash(canonicaliseUriList(dirty))).toBe('sha256-5II58ebcX0p61WxP5aNTJzbQmqc1TxBuNxWkjI79QdA')
  })

  it('dedupes the NSStringPboardType legacy alias against public.utf8-plain-text', async () => {
    const body = 'hello world'
    const out = await normalizeReps([
      rep('text/plain', 'NSStringPboardType', body),
      rep('text/plain', 'public.utf8-plain-text', body),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.uti).toBe('public.utf8-plain-text')
    expect(out[0]!.sha256).toBe(contentHash(Buffer.from(body, 'utf8')))
  })

  it('drops the org.chromium.source-url rep so a Chrome copy hashes like any other', async () => {
    expect(MIME_SOURCE_URL).toBe('text/x-source-url')
    const out = await normalizeReps([
      rep('text/plain', 'public.utf8-plain-text', 'hello world'),
      rep(MIME_SOURCE_URL, 'org.chromium.source-url', 'https://example.com/article'),
    ])
    expect(out.map((r) => r.uti)).toEqual(['public.utf8-plain-text'])
    expect(out.map((r) => r.mime)).toEqual(['text/plain'])
    expect(out[0]!.sha256).toBe(contentHash(Buffer.from('hello world', 'utf8')))
  })

  it('leaves text/plain bytes untouched, CRLF and emoji included', async () => {
    const raw = fx('plain-utf8.txt')
    const out = await normalizeReps([rep('text/plain', 'public.utf8-plain-text', raw)])
    expect(Buffer.compare(Buffer.from(out[0]!.bytes), raw)).toBe(0)
    expect(Buffer.from(out[0]!.bytes).toString('utf8')).toBe('Hello \u{1F30D}\r\nsecond line\n')
  })

  it('orders the output by the frozen primary-rep order so two machines emit identical rows', async () => {
    const out = await normalizeReps([
      rep('text/rtf', 'public.rtf', fx('rtf-minimal.rtf')),
      rep('application/pdf', 'com.adobe.pdf', 'x'),
      rep('image/png', 'public.png', fx('screenshot.png')),
      rep('text/plain', 'public.utf8-plain-text', 'hello world'),
    ])
    expect(out.map((r) => r.mime)).toEqual(['text/plain', 'image/png', 'text/rtf', 'application/pdf'])
  })
})
