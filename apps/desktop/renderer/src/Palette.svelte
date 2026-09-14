<script lang="ts">
  import type { ItemSummary } from '@cairn/protocol'
  import ItemRow from './ItemRow.svelte'
  import Preview from './Preview.svelte'
  import SplitPane from './SplitPane.svelte'
  import Toast from './Toast.svelte'
  import {
    ALL_TAB,
    KIND_FILTERS,
    PINNED_TAB,
    SHORTCUT_HINTS,
    PaletteState,
    ROW_HEIGHT_PX,
    TAG_PLACEHOLDER,
    filePathsFromPreview,
    hotkeyFailedText,
    sameTab,
    type ActiveTab,
    type KindFilter,
    type NavKey,
  } from './palette-state.svelte'

  // NOT `state`: a prop called `state` makes the compiler read `$state(...)` as a store
  // subscription to it, and the component dies with `store_invalid_shape` at runtime.
  interface Props {
    palette: PaletteState
  }
  let { palette }: Props = $props()

  let inputEl: HTMLInputElement | null = $state(null)
  let listEl: HTMLDivElement | null = $state(null)
  let tagEl: HTMLInputElement | null = $state(null)
  let titleEl: HTMLInputElement | null = $state(null)
  let previewLayout: 'bottom' | 'right' = $state('bottom')
  let draggedItem: ItemSummary | null = $state(null)
  let dropTarget: ActiveTab | null = $state(null)
  const clipDragType = 'application/x-cairn-item-id'

  const selected = $derived(palette.selectedItem)
  const activeId = $derived(selected === null ? null : `cairn-row-${selected.id}`)
  const filePaths = $derived(
    selected !== null && selected.kind === 'files' ? filePathsFromPreview(palette.previewText) : [],
  )

  /** All, Pinned, then one per tab that has an item. Pinned is always shown even when empty: it is
   *  the tab that promises nothing in it is ever evicted, so it has to be visible to be believed. */
  const tabs: { tab: ActiveTab; label: string; count: number | null }[] = $derived([
    { tab: ALL_TAB, label: 'All', count: null },
    { tab: PINNED_TAB, label: 'Pinned', count: palette.pinnedCount },
    ...palette.tabs.map((t) => ({
      tab: { kind: 'tag', tag: t.tag } as ActiveTab,
      label: t.tag,
      count: t.count,
    })),
  ])

  // The palette is re-shown without being re-created, so focus follows `shownAt`, not mount.
  $effect(() => {
    void palette.shownAt
    endDrag()
    inputEl?.focus()
  })

  // Opening the tab field moves focus into it, and closing it hands focus back — otherwise the next
  // keystroke after a tab is filed goes nowhere at all.
  $effect(() => {
    if (palette.titleEditing) titleEl?.focus()
    else if (palette.tagging) tagEl?.focus()
    else inputEl?.focus()
  })

  // Fixed row geometry, so the scroll position is a pure function of the window start. Never
  // scrollIntoView(): jsdom does not implement it, and we do not need it.
  $effect(() => {
    const top = palette.windowStart * ROW_HEIGHT_PX
    if (listEl !== null && listEl.scrollTop !== top) listEl.scrollTop = top
  })

  $effect(() => {
    if (listEl === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0
      if (height > 0) palette.setViewportHeight(height)
    })
    observer.observe(listEl)
    return () => observer.disconnect()
  })

  /** A click on a control in the palette must never take focus off the search field. */
  function keepFocus(event: MouseEvent): void {
    event.preventDefault()
  }

  function onKindChange(event: Event & { currentTarget: HTMLSelectElement }): void {
    palette.pending = palette.selectKind(event.currentTarget.value as KindFilter)
    inputEl?.focus({ preventScroll: true })
  }

  function startDrag(event: DragEvent, item: ItemSummary): void {
    if (event.dataTransfer === null || (event.target instanceof Element && event.target.closest('button'))) {
      event.preventDefault()
      return
    }
    draggedItem = item
    event.dataTransfer.setData(clipDragType, item.id)
    event.dataTransfer.effectAllowed = 'copy'
  }

  function endDrag(): void {
    draggedItem = null
    dropTarget = null
  }

  function dragOver(event: DragEvent, tab: ActiveTab): void {
    if (draggedItem === null || tab.kind === 'all') return
    event.preventDefault()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
    dropTarget = tab
  }

  function dropClip(event: DragEvent, tab: ActiveTab): void {
    const item = draggedItem
    if (item === null || tab.kind === 'all' || event.dataTransfer?.getData(clipDragType) !== item.id) return
    event.preventDefault()
    endDrag()
    palette.pending = palette.fileItem(item, tab)
    inputEl?.focus({ preventScroll: true })
  }

  function onKeyDown(event: KeyboardEvent): void {
    const key = event.key
    if (event.target instanceof HTMLSelectElement && key !== 'Escape') return
    if (event.target instanceof HTMLButtonElement && (key === 'Enter' || key === ' ')) return
    if (key === 'Escape') {
      event.preventDefault()
      palette.pending = palette.close()
      return
    }
    if (key === 'Enter') {
      event.preventDefault()
      palette.pending = palette.recall()
      return
    }
    // Home/End drive the list, not the caret: this is a list-first UI and Cmd+Left/Right still
    // moves the caret on macOS.
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault()
      palette.moveSelection(key satisfies NavKey)
      inputEl?.focus({ preventScroll: true })
      return
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'p') {
      event.preventDefault()
      palette.pending = palette.togglePin()
      return
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 't') {
      event.preventDefault()
      palette.openTagging()
      return
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'e') {
      event.preventDefault()
      palette.openTitleEditing()
      return
    }
    if ((event.metaKey || event.ctrlKey) && (key === 'Backspace' || key === 'Delete')) {
      event.preventDefault()
      palette.pending = palette.removeSelected()
    }
  }

  /** The tab field owns Enter and Escape while it is open, so neither reaches the list. */
  function onTagKeyDown(event: KeyboardEvent): void {
    event.stopPropagation()
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) return
    if (event.key === 'Enter') {
      event.preventDefault()
      palette.pending = palette.commitTag()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      palette.closeTagging()
    }
  }

  function onTitleKeyDown(event: KeyboardEvent): void {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      palette.pending = palette.commitTitle()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      palette.closeTitleEditing()
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="palette" onkeydown={onKeyDown} role="none">
  <div class="palette-header">
    <div class="brand">
      <svg class="brand-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="17" width="18" height="4" rx="2" />
        <rect x="6" y="10" width="13" height="5" rx="2.5" />
        <rect x="9" y="3" width="7" height="5" rx="2.5" />
      </svg>
      <span>Cairn</span>
    </div>
    <div class="header-tools">
      <div class="layout-options" role="group" aria-label="Preview layout">
        <button type="button" class="layout-button" aria-label="Preview below list"
          title="Preview below list" aria-pressed={previewLayout === 'bottom'}
          onmousedown={keepFocus} onclick={() => (previewLayout = 'bottom')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2" /><path d="M3 11h14" /></svg>
        </button>
        <button type="button" class="layout-button" aria-label="Preview on right"
          title="Preview on right" aria-pressed={previewLayout === 'right'}
          onmousedown={keepFocus} onclick={() => (previewLayout = 'right')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2" /><path d="M11 3v14" /></svg>
        </button>
      </div>
      <span class="history-count">{palette.total} {palette.total === 1 ? 'clip' : 'clips'}</span>
    </div>
  </div>
  <div class="search-wrap">
    <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
    <input
      bind:this={inputEl}
      class="search"
      data-testid="search"
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls="cairn-results"
      aria-activedescendant={activeId}
      aria-label="Search your clipboard history"
      placeholder="Find a clip or title…"
      autocomplete="off"
      spellcheck="false"
      value={palette.query}
      oninput={(event) => (palette.pending = palette.setQuery(event.currentTarget.value))}
    />
    <kbd class="search-key">⌘ ⇧ V</kbd>
  </div>

  <div class="filter-bar">
  <div class="tabs" data-testid="tabs" role="group" aria-label="Tabs">
    {#each tabs as t (t.label)}
      <button
        type="button"
        class="tab"
        class:tab-active={sameTab(t.tab, palette.activeTab)}
        class:tab-drop-target={dropTarget !== null && sameTab(t.tab, dropTarget)}
        aria-pressed={sameTab(t.tab, palette.activeTab)}
        title={t.tab.kind === 'pinned' ? 'Drop a clip here to pin it' : t.tab.kind === 'tag' ? `Drop a clip here to add it to ${t.label}` : undefined}
        ondragover={(event) => dragOver(event, t.tab)}
        ondragleave={(event) => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) dropTarget = null
        }}
        ondrop={(event) => dropClip(event, t.tab)}
        onmousedown={keepFocus}
        onclick={() => (palette.pending = palette.selectTab(t.tab))}
      >
        {t.label}{#if t.count !== null}<span class="tab-count">{t.count}</span>{/if}
      </button>
    {/each}
    <button
      type="button"
      class="tab tab-new"
      data-testid="new-tab"
      title="File the selected copy into a tab — anything in a tab is kept, never evicted"
      disabled={selected === null}
      onmousedown={keepFocus}
      onclick={() => palette.openTagging()}>+ Tab</button
    >
  </div>
  <div class="type-filter" class:type-filter-active={palette.activeKind !== 'all'}>
    <svg class="filter-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 5h18l-7 8v5l-4 2v-7Z" />
    </svg>
    <select
      aria-label="Filter by type"
      title="Filter clipboard content by type"
      value={palette.activeKind}
      onchange={onKindChange}
    >
      {#each KIND_FILTERS as filter (filter.value)}
        <option value={filter.value}>{filter.label}</option>
      {/each}
    </select>
    <svg class="filter-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
  </div>
  </div>

  {#if palette.titleEditing}
    <div class="title-editor" data-testid="title-editor">
      <label for="clip-title">Title <span>Hides the copied content from view</span></label>
      <div class="title-editor-controls">
        <input
          id="clip-title"
          bind:this={titleEl}
          class="title-input"
          data-testid="title-input"
          aria-label="Clip title"
          placeholder="e.g. Work login"
          maxlength="120"
          autocomplete="off"
          value={palette.titleDraft}
          oninput={(event) => (palette.titleDraft = event.currentTarget.value)}
          onkeydown={onTitleKeyDown}
        />
        <button type="button" class="button-primary" onclick={() => (palette.pending = palette.commitTitle())}>Save</button>
        <button type="button" class="button-quiet" onclick={() => palette.closeTitleEditing()}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if palette.tagging}
    <div class="tag-row" data-testid="tag-row" role="group" aria-label="Choose tabs" onkeydown={onTagKeyDown}>
      <div class="tag-heading">
        <span>{palette.tabs.length > 0 ? 'Choose tabs' : 'Create your first tab'}</span>
        <button type="button" class="button-quiet" aria-label="Done tagging"
          onmousedown={keepFocus} onclick={() => palette.closeTagging()}>Done</button>
      </div>
      {#if palette.tabs.length > 0}
        <div class="tag-options">
          {#each palette.tabs as t (t.tag)}
            {@const assigned = palette.taggingTags.includes(t.tag)}
            <button type="button" class="tag-chip" class:tag-chip-active={assigned}
              aria-label={`${assigned ? 'Remove from' : 'Add to'} ${t.tag}`}
              aria-pressed={assigned} disabled={palette.tagSaving}
              onmousedown={keepFocus}
              onclick={() => (palette.pending = palette.toggleTag(t.tag))}
            >{#if assigned}<span aria-hidden="true">✓ </span>{/if}{t.tag}</button>
          {/each}
        </div>
      {/if}
      <div class="tag-create">
      <input
        bind:this={tagEl}
        class="tag-input"
        data-testid="tag-input"
        type="text"
        aria-label="New tab name"
        placeholder={TAG_PLACEHOLDER}
        autocomplete="off"
        spellcheck="false"
        value={palette.tagDraft}
        oninput={(event) => (palette.tagDraft = event.currentTarget.value)}
      />
        <button type="button" class="button-primary" disabled={palette.tagDraft.trim().length === 0 || palette.tagSaving}
          onmousedown={keepFocus} onclick={() => (palette.pending = palette.commitTag())}>Create tab</button>
      </div>
    </div>
  {/if}

  {#if palette.hotkeyStatus === 'failed'}
    <div class="status-row" data-testid="hotkey-status" role="status">
      {hotkeyFailedText(palette.hotkeyAccelerator)}
    </div>
  {/if}
  {#if palette.statusText !== null}
    <div class="status-row" data-testid="status-text" role="status">{palette.statusText}</div>
  {/if}

  <SplitPane layout={previewLayout}>
  {#snippet list()}
  <div
    bind:this={listEl}
    id="cairn-results"
    class="results"
    role="listbox"
    aria-label="Clipboard history"
    onscroll={(event) => palette.setScrollTop(event.currentTarget.scrollTop)}
  >
    {#if palette.total === 0}
      <div class="empty" data-testid="empty">{palette.emptyText}</div>
    {:else}
      <div class="spacer" data-testid="spacer" style="height: {palette.total * ROW_HEIGHT_PX}px">
        {#each palette.visibleRows as row (row.index)}
          {#if row.item !== null}
            <ItemRow
              item={row.item}
              ranges={row.ranges}
              top={row.top}
              nowMs={palette.nowMs}
              selected={row.index === palette.selectedIndex}
              ondragstart={(event) => { if (row.item !== null) startDrag(event, row.item) }}
              ondragend={endDrag}
              onpick={() => {
                if (draggedItem !== null) return
                palette.hidePreview()
                palette.selectedIndex = row.index
                palette.pending = palette.recall()
              }}
              onview={() => (palette.pending = palette.viewItem(row.index))}
              onpin={() => {
                palette.hidePreview()
                palette.selectedIndex = row.index
                palette.pending = palette.togglePin()
              }}
              ontag={() => {
                palette.hidePreview()
                palette.selectedIndex = row.index
                palette.openTagging()
              }}
              ontitle={() => {
                palette.hidePreview()
                palette.selectedIndex = row.index
                palette.openTitleEditing()
              }}
              ondelete={() => {
                palette.hidePreview()
                palette.selectedIndex = row.index
                palette.pending = palette.removeSelected()
              }}
            />
          {:else}
            <div class="row row-placeholder" style="top: {row.top}px; height: {ROW_HEIGHT_PX}px"></div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
  {/snippet}

  {#snippet preview()}
  <div class="preview-pane" id="cairn-preview">
    <div class="preview-heading">
      <span>Preview</span>
      {#if selected !== null}
        <div class="preview-tools">
          {#if selected.title != null && !palette.contentHidden}
            <button type="button" class="button-quiet" onclick={() => palette.hidePreview()}>Hide content</button>
          {/if}
          <button type="button" class="button-quiet" onclick={() => palette.openTitleEditing()}>
            {selected.title == null ? 'Add title' : 'Edit title'}
          </button>
        </div>
      {/if}
    </div>
    {#if palette.contentHidden}
      <div class="hidden-content" data-testid="hidden-content">
        <div>
          <span class="hidden-content-title">Content hidden</span>
          <p>Copy this clip without showing it on screen.</p>
        </div>
        <button
          type="button"
          class="button-quiet reveal-button"
          data-testid="reveal-content"
          onclick={() => (palette.pending = palette.revealPreview())}>Reveal</button
        >
      </div>
    {:else}
      <Preview text={palette.previewText} mime={palette.previewMime} {filePaths}
        imageDataUrl={palette.previewImageUrl} imageOnly={selected?.kind === 'image'}
        truncated={palette.previewTruncated} />
    {/if}
  </div>
  {/snippet}
  </SplitPane>

  <!-- Real buttons, not a legend. Pin, tab and delete are all still keyboard shortcuts, and each
       one is now also something you can click, which is how it becomes discoverable. -->
  <div class="hints" data-testid="hints">
    {#each SHORTCUT_HINTS as hint (hint.keys)}
      {#if hint.action === null}
        <span class="hint"><kbd>{hint.keys}</kbd> {hint.label}</span>
      {:else}
        <button
          type="button"
          class="hint hint-button"
          disabled={selected === null && hint.action !== 'close'}
          onmousedown={keepFocus}
          onclick={() => (palette.pending = palette.run(hint.action))}
        >
          <kbd>{hint.keys}</kbd> {hint.label}
        </button>
      {/if}
    {/each}
  </div>

  {#if palette.toast !== null}
    <Toast text={palette.toast.text} tone={palette.toast.tone} />
  {/if}
</div>
