import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  BLOB_HKDF_INFO,
  contentHash,
  err,
  ok,
  type BlobId,
  type Logger,
  type Result,
} from '@cairn/protocol'
import { NONCE_BYTES, TAG_BYTES } from './record'
import { ensureDir0700, fsyncPath, writeFile0600 } from './paths'

export interface BlobStore {
  put(bytes: Uint8Array): Result<BlobId>
  get(id: BlobId): Result<Buffer>
  remove(id: BlobId): Result<boolean>
  has(id: BlobId): boolean
  /** Absolute path of the file that holds `id`, whether or not it exists. */
  fileFor(id: BlobId): string
  files(): readonly string[]
  totalBytes(): number
  close(): void
}

/**
 * Two HKDF-SHA256 derivations, both under the info string `'cairn/blob/v1'`:
 *
 * - the **name** subkey — one per store, empty salt — HMACs a blob id into a filename. The
 *   filename is an HMAC rather than the id itself because a plaintext content hash on disk is a
 *   confirmation oracle — "is one of these files sha256('hunter2')?" — and clipboard content is
 *   often guessable.
 * - the **body** subkey — one per blob, salt = that blob's id — seals that blob and no other.
 *   Spec §11 control 7 requires per-blob subkeys: unlinking a file does not erase it from free
 *   space, so what is supposed to make a deleted blob unrecoverable is that its key is gone. The
 *   salt is the plaintext sha256, which is recorded nowhere on disk except inside the sealed
 *   record that referenced the blob — so once `remove()` has unlinked the body and compaction has
 *   dropped that record, nothing left on disk lets the subkey be re-derived from the master key.
 */
export function createBlobStore(opts: { blobDir: string; key: Buffer; logger: Logger }): BlobStore {
  ensureDir0700(opts.blobDir)
  const nameKey = Buffer.from(hkdfSync('sha256', opts.key, new Uint8Array(0), BLOB_HKDF_INFO, 32))

  /** The subkey for ONE blob. The salt is the blob id, so no two blobs share a body key. */
  const bodyKeyFor = (id: BlobId): Buffer =>
    Buffer.from(hkdfSync('sha256', opts.key, Buffer.from(id, 'utf8'), BLOB_HKDF_INFO, 32))

  const fileFor = (id: BlobId): string =>
    join(opts.blobDir, `${createHmac('sha256', nameKey).update(id).digest('base64url')}.blob`)

  return {
    fileFor,
    has: (id) => existsSync(fileFor(id)),
    files: () => readdirSync(opts.blobDir).map((f) => join(opts.blobDir, f)),
    totalBytes: () =>
      readdirSync(opts.blobDir).reduce((sum, f) => sum + statSync(join(opts.blobDir, f)).size, 0),
    put(bytes) {
      const id = contentHash(bytes) as BlobId
      const dest = fileFor(id)
      if (existsSync(dest)) return ok(id)
      const bodyKey = bodyKeyFor(id)
      const nonce = randomBytes(NONCE_BYTES)
      let sealed: Buffer
      try {
        const cipher = createCipheriv('aes-256-gcm', bodyKey, nonce)
        // The plaintext hash is both the AAD and the subkey salt, so a sealed body cannot be moved
        // onto another blob's id: it would be the wrong key AND the wrong AAD.
        cipher.setAAD(Buffer.from(id, 'utf8'))
        sealed = Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
      } finally {
        // The body subkey is derived per call and never outlives it, on EVERY exit path — the wipe
        // is in a `finally` so a throw out of `createCipheriv` cannot leave a live key behind.
        // `[verified]` `tsc --strict` accepts `sealed` as definitely assigned after a `try/finally`
        // with no `catch`, because a throw inside the try propagates instead of falling through.
        bodyKey.fill(0)
      }
      const tmp = `${dest}.tmp`
      try {
        // Write, fsync, rename, fsync the dir — all BEFORE the caller appends the referencing
        // event, so a crash can leak an orphan blob but never a dangling reference (spec §4).
        writeFile0600(tmp, sealed)
        fsyncPath(tmp)
        renameSync(tmp, dest)
        fsyncPath(opts.blobDir)
      } catch (cause) {
        return err('E_STORE_IO', `blob write failed: ${(cause as Error).message}`)
      }
      opts.logger.info('store.blob-written', {
        byteLength: bytes.byteLength,
        hashPrefix: id.slice(0, 12),
      })
      return ok(id)
    },
    get(id) {
      const file = fileFor(id)
      if (!existsSync(file)) return err('E_BLOB_MISSING', `blob ${id.slice(0, 12)} is not on disk`)
      const raw = readFileSync(file)
      if (raw.length < NONCE_BYTES + TAG_BYTES) {
        return err('E_STORE_DECRYPT', `blob ${id.slice(0, 12)} is too short to be a blob`)
      }
      const bodyKey = bodyKeyFor(id)
      let plaintext: Buffer
      try {
        const decipher = createDecipheriv('aes-256-gcm', bodyKey, raw.subarray(0, NONCE_BYTES))
        decipher.setAAD(Buffer.from(id, 'utf8'))
        decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
        const head = decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES))
        plaintext = Buffer.concat([head, decipher.final()])
      } catch {
        return err('E_STORE_DECRYPT', `blob ${id.slice(0, 12)} failed to authenticate`)
      } finally {
        // The body subkey is derived per call and never outlives it.
        bodyKey.fill(0)
      }
      if (contentHash(plaintext) !== id) {
        return err('E_STORE_CORRUPT', `blob ${id.slice(0, 12)} does not hash to its own id`)
      }
      return ok(plaintext)
    },
    remove(id) {
      const file = fileFor(id)
      if (!existsSync(file)) return ok(false)
      try {
        unlinkSync(file)
        fsyncPath(opts.blobDir)
      } catch (cause) {
        return err('E_STORE_IO', `blob delete failed: ${(cause as Error).message}`)
      }
      return ok(true)
    },
    close() {
      // The only derived material that outlives a call. After this, `fileFor` HMACs under 32 zero
      // bytes — legal, but it names a different file, so `get` reports E_BLOB_MISSING.
      nameKey.fill(0)
    },
  }
}
