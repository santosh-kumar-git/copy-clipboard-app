import { NON_SYNCABLE_FLAGS, type Flag, type Item } from '@cairn/protocol'

/** THROWS on purpose. A silent filter is how "why didn't my item sync?" becomes unanswerable. */
export function assertSyncable(item: Item): void {
  const offending = item.flags.filter((f) => (NON_SYNCABLE_FLAGS as readonly Flag[]).includes(f))
  if (offending.length > 0) {
    throw new Error(`cairn: refusing to sync item ${item.id}: flags ${offending.join(',')}`)
  }
}
