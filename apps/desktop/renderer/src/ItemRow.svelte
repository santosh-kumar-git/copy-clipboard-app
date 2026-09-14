<script lang="ts">
  import type { ItemSummary } from '@cairn/protocol'
  import { safeThumbnailSrc } from './api'
  import {
    ROW_HEIGHT_PX,
    highlightSegments,
    kindChipLabel,
    rowFallbackLabel,
    secretExpiryLabel,
  } from './palette-state.svelte'

  interface Props {
    item: ItemSummary
    selected: boolean
    ranges: readonly number[]
    top: number
    nowMs: number
    onpick: () => void
    onview: () => void
    onpin: () => void
    ontag: () => void
    ontitle: () => void
    ondelete: () => void
    ondragstart?: (event: DragEvent) => void
    ondragend?: () => void
  }
  let { item, selected, ranges, top, nowMs, onpick, onview, onpin, ontag, ontitle, ondelete, ondragstart, ondragend }: Props = $props()

  const label = $derived(item.title ?? item.preview)
  const segments = $derived(highlightSegments(label, ranges))
  const thumbnail = $derived(item.title == null ? safeThumbnailSrc(item.thumbnailDataUrl) : null)
  const expiry = $derived(secretExpiryLabel(item.expiresAt, nowMs))

  /** A row action must not also count as picking the row, and must not steal focus from the search
   *  field — losing focus there means the next keystroke goes nowhere. */
  function act(run: () => void): (event: MouseEvent) => void {
    return (event) => {
      event.stopPropagation()
      event.preventDefault()
      run()
    }
  }
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
  draggable={ondragstart !== undefined}
  {ondragstart}
  {ondragend}
  style="top: {top}px; height: {ROW_HEIGHT_PX}px"
  onclick={onpick}
>
  <span class="drag-handle" title="Drag this clip onto a tab" aria-hidden="true">
    <svg viewBox="0 0 10 16"><circle cx="3" cy="4" r="1"/><circle cx="7" cy="4" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="7" cy="8" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="7" cy="12" r="1"/></svg>
  </span>
  <span class="chip" data-kind={item.kind}>{kindChipLabel(item.kind)}</span>
  {#if thumbnail !== null}
    <img class="thumb" src={thumbnail} alt="" width="32" height="32" draggable="false" />
  {/if}
  {#if label.length === 0}
    <!-- An image has no text preview and, until thumbnails are actually served, no thumbnail
         either — so the row rendered completely blank, which looked exactly like the evicted
         preview-cache bug. Describing the item keeps "blank row" meaning "something is wrong". -->
    <span class="row-preview row-preview-fallback">{rowFallbackLabel(item)}</span>
  {:else}
    <span class="row-preview"
      >{#each segments as seg, i (i)}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span
    >
  {/if}
  {#if item.title != null || item.tags.length > 0 || item.pinned || item.flags.includes('secret')}
    <span class="row-badges">
      {#if item.title != null}<span class="badge badge-private">Hidden</span>{/if}
      {#each item.tags.slice(0, 2) as tag (tag)}<span class="badge badge-tab" title={tag}>{tag}</span>{/each}
      {#if item.tags.length > 2}<span class="badge" title={item.tags.slice(2).join(', ')}>+{item.tags.length - 2}</span>{/if}
      {#if item.pinned}<span class="badge badge-pinned">Pinned</span>{/if}
      {#if item.flags.includes('secret')}
        <span class="badge badge-secret">Secret{expiry === null ? '' : ` · ${expiry}`}</span>
      {/if}
    </span>
  {/if}

  <!-- Every row action used to be keyboard-only, so with a mouse in your hand the pin and tab
       features did not exist. Shown on hover and on the selected row; `onmousedown` is prevented so
       the click never moves focus out of the search field. -->
  <span class="row-actions">
    <button
      type="button"
      class="row-btn row-view"
      title="View content without copying"
      aria-label={`View ${label || rowFallbackLabel(item)}`}
      onmousedown={(e) => e.preventDefault()}
      onclick={act(onview)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
    <button
      type="button"
      class="row-btn"
      title={item.title == null ? 'Add title (⌘E)' : 'Edit title (⌘E)'}
      aria-label={`Edit title for ${label}`}
      onmousedown={(e) => e.preventDefault()}
      onclick={act(ontitle)}>Aa</button
    >
    <button
      type="button"
      class="row-btn"
      title={item.pinned ? 'Unpin' : 'Pin (never evicted)'}
      aria-label={item.pinned ? `Unpin ${label}` : `Pin ${label}`}
      onmousedown={(e) => e.preventDefault()}
      onclick={act(onpin)}>{item.pinned ? '★' : '☆'}</button
    >
    <button
      type="button"
      class="row-btn"
      title="Add to tab (⌘T)"
      aria-label={`Add ${label} to a tab`}
      onmousedown={(e) => e.preventDefault()}
      onclick={act(ontag)}><svg class="tab-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 6V4.5h6l2 2h7v10h-15Z"/><path d="M10 9v5m-2.5-2.5h5"/></svg></button
    >
    <button
      type="button"
      class="row-btn row-btn-danger"
      title="Delete"
      aria-label={`Delete ${label}`}
      onmousedown={(e) => e.preventDefault()}
      onclick={act(ondelete)}>✕</button
    >
  </span>
</div>
