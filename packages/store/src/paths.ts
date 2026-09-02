import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_BLOB_DIR, STORE_KEY_FILE, STORE_LOG_FILE, STORE_META_FILE } from '@cairn/protocol'

export interface DataDirLayout {
  readonly dir: string
  readonly logPath: string
  readonly tmpLogPath: string
  readonly metaPath: string
  readonly keyPath: string
  readonly blobDir: string
}

export function dataDirLayout(dir: string): DataDirLayout {
  return {
    dir,
    logPath: join(dir, STORE_LOG_FILE),
    tmpLogPath: join(dir, `${STORE_LOG_FILE}.tmp`),
    metaPath: join(dir, STORE_META_FILE),
    keyPath: join(dir, STORE_KEY_FILE),
    blobDir: join(dir, STORE_BLOB_DIR),
  }
}

/** mkdir -p 0700, then an explicit chmod: the `mode` argument is masked by the process umask,
 *  chmod is not. Under `umask 0222` a mode-0700 mkdir actually lands at 0500. */
export function ensureDir0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

export function writeFile0600(filePath: string, bytes: string | Uint8Array): void {
  writeFileSync(filePath, bytes, { mode: 0o600 })
  chmodSync(filePath, 0o600)
}

/** Appends one `\n`-terminated line and fsyncs it. The trailing newline is the commit marker:
 *  a line without one never became durable. `appendFileSync`'s `mode` option is ignored for an
 *  existing file, so the chmod is what keeps 0600 across appends. */
export function appendLine0600(filePath: string, line: string): void {
  if (!existsSync(filePath)) writeFile0600(filePath, '')
  const fd = openSync(filePath, 'a')
  try {
    writeSync(fd, `${line}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(filePath, 0o600)
}

/** fsync a file OR a directory, so a create or a rename is durable before the next step. */
export function fsyncPath(target: string): void {
  const fd = openSync(target, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
