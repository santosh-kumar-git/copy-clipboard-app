import { SECRET_TTL_MS, type Flag } from '@cairn/protocol'

/** The one place the secret TTL is applied. `null` means "no TTL — normal retention rules". */
export function secretExpiresAt(createdAt: number, flags: readonly Flag[]): number | null {
  return flags.includes('secret') ? createdAt + SECRET_TTL_MS : null
}

/** Secrets are exempt from pinning, because a pin would defeat the 5-minute TTL. */
export function isPinnable(flags: readonly Flag[]): boolean {
  return !flags.includes('secret')
}
