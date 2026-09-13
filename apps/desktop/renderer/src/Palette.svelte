<script lang="ts">
  import ItemRow from './ItemRow.svelte'
  import Preview from './Preview.svelte'
  import SplitPane from './SplitPane.svelte'
  import Toast from './Toast.svelte'
  import {
    ALL_TAB,
    PINNED_TAB,
    SHORTCUT_HINTS,
    PaletteState,
    ROW_HEIGHT_PX,
    TAG_PLACEHOLDER,
    filePathsFromPreview,
    hotkeyFailedText,
    sameTab,
    type ActiveTab,
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

  function onKeyDown(event: KeyboardEvent): void {
    const key = event.key
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
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      palette.pending = palette.commitTag()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
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
    <span class="history-count">{palette.total} {palette.total === 1 ? 'clip' : 'clips'}</span>
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

  <div class="tabs" data-testid="tabs" role="group" aria-label="Tabs">
    {#each tabs as t (t.label)}
      <button
        type="button"
        class="tab"
        class:tab-active={sameTab(t.tab, palette.activeTab)}
        aria-pressed={sameTab(t.tab, palette.activeTab)}
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
    <div class="tag-row" data-testid="tag-row">
      <input
        bind:this={tagEl}
        class="tag-input"
        data-testid="tag-input"
        type="text"
        list="cairn-tab-names"
        aria-label="Tab name"
        placeholder={TAG_PLACEHOLDER}
        autocomplete="off"
        spellcheck="false"
        value={palette.tagDraft}
        oninput={(event) => (palette.tagDraft = event.currentTarget.value)}
        onkeydown={onTagKeyDown}
      />
      <datalist id="cairn-tab-names">
        {#each palette.tabs as t (t.tag)}<option value={t.tag}></option>{/each}
      </datalist>
      {#each selected?.tags ?? [] as tag (tag)}
        <button
          type="button"
          class="tag-chip"
          title={`Take this copy out of ${tag}`}
          onmousedown={keepFocus}
          onclick={() => (palette.pending = palette.untag(tag))}>{tag} ✕</button
        >
      {/each}
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

  <SplitPane>
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
              onpick={() => {
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
