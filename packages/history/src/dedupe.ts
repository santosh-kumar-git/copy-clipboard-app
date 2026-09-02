import type { ContentHash, Item, ItemId, ItemPatch } from '@cairn/protocol'

/** Rebuilt from scratch on every `load()`, which is why it is a plain function of the items. */
export function indexByContentHash(items: Iterable<Item>): Map<ContentHash, ItemId> {
  const m = new Map<ContentHash, ItemId>()
  for (const it of items) m.set(it.contentHash, it.id)
  return m
}

/** A re-copy bumps `updatedAt` and writes an ITEM_UPDATED — never a second row (spec §4). */
export function bumpUpdatedAt(item: Item, nowMs: number): { readonly item: Item; readonly patch: ItemPatch } {
  return { item: { ...item, updatedAt: nowMs }, patch: { updatedAt: nowMs } }
}
