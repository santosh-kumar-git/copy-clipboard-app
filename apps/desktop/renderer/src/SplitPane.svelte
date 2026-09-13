<script lang="ts">
  import type { Snippet } from 'svelte'

  let { list, preview }: { list: Snippet; preview: Snippet } = $props()
  let container: HTMLDivElement | null = $state(null)
  let height = $state(400)
  let proportion = $state(0.72)
  let pointer: number | null = $state(null)
  let pointerOffset = 0
  const dividerHeight = 12
  const minimum = $derived(Math.min(0.5, 88 / Math.max(1, height - dividerHeight)))
  const maximum = $derived(1 - minimum)
  const fraction = $derived(Math.max(minimum, Math.min(maximum, proportion)))

  $effect(() => {
    if (container === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.height ?? 0
      if (next > 0) height = next
    })
    observer.observe(container)
    return () => observer.disconnect()
  })

  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || container === null) return
    event.preventDefault()
    const divider = event.currentTarget as HTMLElement
    pointerOffset = event.clientY - divider.getBoundingClientRect().top
    pointer = event.pointerId
    divider.setPointerCapture(event.pointerId)
  }

  function resize(event: PointerEvent): void {
    if (pointer !== event.pointerId || container === null) return
    const bounds = container.getBoundingClientRect()
    if (bounds.height <= dividerHeight) return
    proportion = Math.max(minimum, Math.min(maximum,
      (event.clientY - bounds.top - pointerOffset) / (bounds.height - dividerHeight)))
  }

  function stopResize(event: PointerEvent): void {
    if (pointer !== event.pointerId) return
    pointer = null
    const divider = event.currentTarget as HTMLElement
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId)
  }

  function keyResize(event: KeyboardEvent): void {
    if (event.key === 'Escape') return
    event.stopPropagation()
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'ArrowUp') proportion = Math.max(minimum, fraction - 0.05)
    if (event.key === 'ArrowDown') proportion = Math.min(maximum, fraction + 0.05)
    if (event.key === 'Home') proportion = minimum
    if (event.key === 'End') proportion = maximum
  }
</script>

<div class="content-panes" class:resizing={pointer !== null} bind:this={container}
  style={`--list-fraction: ${fraction}; --divider-height: ${dividerHeight}px`}>
  {@render list()}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (A focusable separator implements the ARIA window splitter pattern.) -->
  <div
    class="pane-divider"
    role="separator"
    tabindex="0"
    aria-label="Resize preview"
    aria-orientation="horizontal"
    aria-controls="cairn-results cairn-preview"
    aria-valuemin={Math.round(minimum * 100)}
    aria-valuemax={Math.round(maximum * 100)}
    aria-valuenow={Math.round(fraction * 100)}
    aria-valuetext={`${Math.round((1 - fraction) * 100)}% preview`}
    title="Drag to resize preview"
    onpointerdown={startResize}
    onpointermove={resize}
    onpointerup={stopResize}
    onpointercancel={stopResize}
    onlostpointercapture={() => { pointer = null }}
    onkeydown={keyResize}
    ondblclick={() => { proportion = 0.72 }}
  ><span></span></div>
  {@render preview()}
</div>
