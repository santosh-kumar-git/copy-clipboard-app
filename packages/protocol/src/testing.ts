// packages/protocol/src/testing.ts — the ONE way a test finds a fixture (contract §7).
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Repo root, resolved from this file, so a test's cwd never matters. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const fixturePath = (...p: string[]): string => join(REPO_ROOT, 'fixtures', ...p)
