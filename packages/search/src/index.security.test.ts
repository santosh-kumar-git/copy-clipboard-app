import { describe, expect, it } from 'vitest'
import type { ItemId } from '@cairn/protocol'
import { mask } from '@cairn/privacy'
import { createSearchIndex } from './index'

/** The exact key from the M1 demo. `mask()` must render it `AKIA••••A7QD`. */
const RAW_AWS_KEY = 'AKIA2E0PQIN4XA7QD'

describe('the in-memory index never holds a raw secret', () => {
  it('stores the masked preview, so the raw value is neither searchable nor readable', () => {
    const masked = mask(RAW_AWS_KEY).preview
    expect(masked).toBe('AKIA••••A7QD')

    const ix = createSearchIndex()
    ix.add({ id: 'ITEM1' as ItemId, preview: masked, pinned: false, updatedAt: 1, ord: 1 })

    // debugHaystack() is the WHOLE plaintext surface of the index. Read all of it.
    expect(ix.debugHaystack()).toEqual(['AKIA••••A7QD'])
    expect(JSON.stringify(ix.debugHaystack())).not.toContain(RAW_AWS_KEY)
    // Searching for the raw key finds nothing, because the raw key is not here.
    expect(ix.query(RAW_AWS_KEY, 10)).toEqual([])
    // The masked row is still findable by its visible prefix.
    expect(ix.query('akia', 10).map((h) => String(h.id))).toEqual(['ITEM1'])
  })

  it('a pinned row is no exception — the haystack is masked previews only', () => {
    const ix = createSearchIndex()
    ix.add({
      id: 'P' as ItemId,
      preview: mask(`token ${RAW_AWS_KEY} end`).preview,
      pinned: true,
      updatedAt: 1,
      ord: 1,
    })
    expect(ix.debugHaystack()).toEqual(['token AKIA••••A7QD end'])
    expect(JSON.stringify(ix.debugHaystack())).not.toContain(RAW_AWS_KEY)
  })

  it('clear() leaves no plaintext behind for a later query to find', () => {
    const ix = createSearchIndex()
    ix.add({ id: 'ITEM1' as ItemId, preview: 'AKIA••••A7QD', pinned: false, updatedAt: 1, ord: 1 })
    ix.clear()
    expect(ix.size).toBe(0)
    expect(ix.debugHaystack()).toEqual([])
    expect(ix.query('akia', 10)).toEqual([])
  })
})
