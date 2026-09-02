import { createDecipheriv, createHmac, hkdfSync } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BLOB_HKDF_INFO, contentHash, type BlobId } from '@cairn/protocol'
import { createBlobStore } from './blobs'
import { randomTestKey, silentLogger, tempStoreDir } from './testing'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function freshBlobStore() {
  const { dir, cleanup } = tempStoreDir()
  cleanups.push(cleanup)
  const blobDir = join(dir, 'blobs')
  const key = randomTestKey()
  return { dir, blobDir, key, blobs: createBlobStore({ blobDir, key, logger: silentLogger }) }
}

const MISSING = ('sha256-' + 'C'.repeat(43)) as BlobId

describe('createBlobStore', () => {
  it('addresses a blob by the sha256 of its PLAINTEXT and round-trips it', () => {
    const { blobs } = freshBlobStore()
    const bytes = Buffer.from('a fairly secret blob body')
    const put = blobs.put(bytes)
    expect(put.ok).toBe(true)
    if (!put.ok) throw new Error('unreachable')
    expect(put.value).toBe(contentHash(bytes))
    expect(put.value).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/)
    const got = blobs.get(put.value)
    expect(got.ok).toBe(true)
    if (!got.ok) throw new Error('unreachable')
    expect(got.value.equals(bytes)).toBe(true)
  })

  it('is idempotent: the same bytes twice is one file', () => {
    const { blobDir, blobs } = freshBlobStore()
    const bytes = Buffer.from('same body')
    const first = blobs.put(bytes)
    const second = blobs.put(bytes)
    expect(first.ok && second.ok && first.value === second.value).toBe(true)
    expect(readdirSync(blobDir)).toHaveLength(1)
  })

  it('stores nonce || ct || tag and never the plaintext', () => {
    const { blobDir, blobs } = freshBlobStore()
    const bytes = Buffer.from('the-plaintext-marker')
    const put = blobs.put(bytes)
    if (!put.ok) throw new Error('unreachable')
    const files = readdirSync(blobDir)
    expect(files).toHaveLength(1)
    const file = join(blobDir, files[0] as string)
    expect(statSync(file).size).toBe(bytes.length + 12 + 16)
    expect(readFileSync(file).includes('the-plaintext-marker')).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(blobDir).mode & 0o777).toBe(0o700)
  })

  it('does not put the blob id in the filename, so the disk is no confirmation oracle', () => {
    const { blobDir, blobs } = freshBlobStore()
    const put = blobs.put(Buffer.from('guessable'))
    if (!put.ok) throw new Error('unreachable')
    const name = readdirSync(blobDir)[0] as string
    expect(name.endsWith('.blob')).toBe(true)
    expect(name).not.toContain(put.value.slice(7))
    expect(blobs.fileFor(put.value)).toBe(join(blobDir, name))
  })

  it('is keyed: another key cannot read the same file', () => {
    const { blobDir, blobs } = freshBlobStore()
    const put = blobs.put(Buffer.from('under key A'))
    if (!put.ok) throw new Error('unreachable')
    const other = createBlobStore({ blobDir, key: randomTestKey(), logger: silentLogger })
    expect(other.has(put.value)).toBe(false)
    expect(other.get(put.value).ok).toBe(false)
  })

  it('reports a missing blob as E_BLOB_MISSING and never throws', () => {
    const { blobs } = freshBlobStore()
    const got = blobs.get(MISSING)
    expect(got.ok).toBe(false)
    if (got.ok) throw new Error('unreachable')
    expect(got.code).toBe('E_BLOB_MISSING')
    expect(blobs.has(MISSING)).toBe(false)
  })

  it('refuses a tampered body and a tampered nonce', () => {
    const { blobDir, blobs } = freshBlobStore()
    const put = blobs.put(Buffer.from('tamper me please, at length'))
    if (!put.ok) throw new Error('unreachable')
    const file = join(blobDir, readdirSync(blobDir)[0] as string)
    const body = readFileSync(file)
    body.writeUInt8(body.readUInt8(body.length - 20) ^ 0xff, body.length - 20)
    writeFileSync(file, body)
    const got = blobs.get(put.value)
    expect(got.ok).toBe(false)
    if (got.ok) throw new Error('unreachable')
    expect(got.code).toBe('E_STORE_DECRYPT')
    const nonceTampered = readFileSync(file)
    nonceTampered.writeUInt8(nonceTampered.readUInt8(0) ^ 0xff, 0)
    writeFileSync(file, nonceTampered)
    expect(blobs.get(put.value).ok).toBe(false)
  })

  it('deletes once, then reports false, and totals bytes', () => {
    const { blobs } = freshBlobStore()
    const put = blobs.put(Buffer.from('0123456789'))
    if (!put.ok) throw new Error('unreachable')
    expect(blobs.totalBytes()).toBe(10 + 28)
    expect(blobs.files()).toHaveLength(1)
    const first = blobs.remove(put.value)
    const second = blobs.remove(put.value)
    expect(first.ok && first.value).toBe(true)
    expect(second.ok && second.value).toBe(false)
    expect(blobs.files()).toHaveLength(0)
  })

  it('derives a DIFFERENT body subkey per blob, so one blob cannot open another (spec §11 control 7)', () => {
    const { blobDir, key, blobs } = freshBlobStore()
    const a = blobs.put(Buffer.from('body of blob A'))
    const b = blobs.put(Buffer.from('body of blob B'))
    if (!a.ok || !b.ok) throw new Error('unreachable')

    // The derivation this test pins: HKDF-SHA256(master, salt = the blob id, info = 'cairn/blob/v1').
    const subkey = (id: BlobId): Buffer =>
      Buffer.from(hkdfSync('sha256', key, Buffer.from(id, 'utf8'), BLOB_HKDF_INFO, 32))
    expect(subkey(a.value).equals(subkey(b.value))).toBe(false)

    const openWith = (id: BlobId, bodyKey: Buffer): Buffer => {
      const raw = readFileSync(blobs.fileFor(id))
      const decipher = createDecipheriv('aes-256-gcm', bodyKey, raw.subarray(0, 12))
      decipher.setAAD(Buffer.from(id, 'utf8'))
      decipher.setAuthTag(raw.subarray(raw.length - 16))
      return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()])
    }
    // A's own subkey opens A's body…
    expect(openWith(a.value, subkey(a.value)).toString('utf8')).toBe('body of blob A')
    // …and B's subkey opens nothing of A's. That is what makes destroying one blob's key mean
    // something: it is not also every other blob's key.
    expect(() => openWith(a.value, subkey(b.value))).toThrow(/unable to authenticate data/)
    expect(readdirSync(blobDir)).toHaveLength(2)
  })

  it('zero-fills the derived name subkey on close, without touching the caller master key', () => {
    const { blobDir, key } = freshBlobStore()
    const blobs = createBlobStore({ blobDir, key, logger: silentLogger })
    const put = blobs.put(Buffer.from('before close'))
    if (!put.ok) throw new Error('unreachable')
    const fileBefore = blobs.fileFor(put.value)
    blobs.close()
    // The name subkey is a closure local, so its CONTENTS are asserted through the one function
    // that reads it: after `close()`, `fileFor` must produce the HMAC taken under 32 ZERO bytes.
    // Only an all-zero buffer can give that answer, so this is a contents assertion, not a
    // behavioural one.
    const zeroKeyName = `${createHmac('sha256', Buffer.alloc(32)).update(put.value).digest('base64url')}.blob`
    expect(basename(blobs.fileFor(put.value))).toBe(zeroKeyName)
    expect(basename(fileBefore)).not.toBe(zeroKeyName)
    // Naming a file that does not exist is reported as state; `get` does not throw, and it destroys
    // nothing on disk.
    const after = blobs.get(put.value)
    expect(after.ok).toBe(false)
    if (after.ok) throw new Error('unreachable')
    expect(after.code).toBe('E_BLOB_MISSING')
    // Proof that only the DERIVED material was wiped: the caller's master key still opens the blob.
    const fresh = createBlobStore({ blobDir, key, logger: silentLogger })
    const reread = fresh.get(put.value)
    expect(reread.ok && reread.value.toString('utf8')).toBe('before close')
  })
})
