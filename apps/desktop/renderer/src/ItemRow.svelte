<script lang="ts">
  import type { ItemSummary } from '@cairn/protocol'
  import { safeThumbnailSrc } from './api'
  import {
    ROW_HEIGHT_PX,
    highlightSegments,
    kindChipLabel,
    secretExpiryLabel,
  } from './palette-state.svelte'

  interface Props {
    item: ItemSummary
    selected: boolean
    ranges: readonly number[]
    top: number
    nowMs: number
    onpick: () => void
  }
  let { item, selected, ranges, top, nowMs, onpick }: Props = $props()

  const segments = $derived(highlightSegments(item.preview, ranges))
  const thumbnail = $derived(safeThumbnailSrc(item.thumbnailDataUrl))
  const expiry = $derived(secretExpiryLabel(item.expiresAt, nowMs))
</script>

<!-- The listbox container owns the keyboard; a row is reachable only via aria-activedescendant,
     so it takes tabindex="-1" and no key handler of its own. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  id={'cairn-row-' + item.id}
  tabindex="-1"
  class="row"
  class:selected
  role="option"
  aria-selected={selected}
  style="top: {top}px; height: {ROW_HEIGHT_PX}px"
  onclick={onpick}
>
  <span class="chip" data-kind={item.kind}>{kindChipLabel(item.kind)}</span>
  {#if thumbnail !== null}
    <img class="thumb" src={thumbnail} alt="" width="32" height="32" />
  {/if}
  <span class="row-preview"
    >{#each segments as seg, i (i)}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span
  >
  {#if item.pinned}<span class="badge badge-pinned">Pinned</span>{/if}
  {#if item.flags.includes('secret')}
    <span class="badge badge-secret">Secret{expiry === null ? '' : ` · ${expiry}`}</span>
  {/if}
</div>
