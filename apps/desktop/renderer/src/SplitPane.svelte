<script lang="ts">
  import type { Snippet } from 'svelte'

  let { list, preview, layout = 'bottom' }: { list: Snippet; preview: Snippet; layout?: 'bottom' | 'right' } = $props()
  let container: HTMLDivElement | null = $state(null)
  let height = $state(400)
  let width = $state(720)
  let bottomProportion = $state(0.72)
  let rightProportion = $state(0.6)
  let pointer: number | null = $state(null)
  let pointerOffset = 0
  const dividerSize = 12
  const sideBySide = $derived(layout === 'right')
  const available = $derived(Math.max(1, (sideBySide ? width : height) - dividerSize))
  const listMinimum = $derived(sideBySide ? 320 : 88)
  const previewMinimum = $derived(sideBySide ? 200 : 88)
  const minimumShare = $derived(listMinimum / (listMinimum + previewMinimum))
  const minimum = $derived(Math.min(minimumShare, listMinimum / available))
  const maximum = $derived(Math.max(minimumShare, 1 - previewMinimum / available))
  const fraction = $derived(Math.max(minimum, Math.min(maximum, sideBySide ? rightProportion : bottomProportion)))

  function setProportion(value: number): void {
    if (sideBySide) rightProportion = value
    else bottomProportion = value
  }

  $effect(() => {
    if (container === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const bounds = entries[0]?.contentRect
      if (bounds !== undefined && bounds.height > 0) height = bounds.height
      if (bounds !== undefined && bounds.width > 0) width = bounds.width
    })
    observer.observe(container)
    return () => observer.disconnect()
  })

  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || container === null) return
    event.preventDefault()
    const divider = event.currentTarget as HTMLElement
    const bounds = divider.getBoundingClientRect()
    pointerOffset = sideBySide ? event.clientX - bounds.left : event.clientY - bounds.top
    pointer = event.pointerId
    divider.setPointerCapture(event.pointerId)
  }

  function resize(event: PointerEvent): void {
    if (pointer !== event.pointerId || container === null) return
    const bounds = container.getBoundingClientRect()
    const size = sideBySide ? bounds.width : bounds.height
    if (size <= dividerSize) return
    const position = sideBySide ? event.clientX - bounds.left : event.clientY - bounds.top
    setProportion(Math.max(minimum, Math.min(maximum, (position - pointerOffset) / (size - dividerSize))))
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
    const decrease = sideBySide ? 'ArrowLeft' : 'ArrowUp'
    const increase = sideBySide ? 'ArrowRight' : 'ArrowDown'
    if (![decrease, increase, 'Home', 'End', 'Enter', ' '].includes(event.key)) return
    event.preventDefault()
    if (event.key === decrease) setProportion(Math.max(minimum, fraction - 0.05))
    if (event.key === increase) setProportion(Math.min(maximum, fraction + 0.05))
    if (event.key === 'Home') setProportion(minimum)
    if (event.key === 'End') setProportion(maximum)
  }
</script>

<div class="content-panes" class:side-by-side={sideBySide} class:resizing={pointer !== null} bind:this={container}
  style={`--list-fraction: ${fraction}; --divider-size: ${dividerSize}px`}>
  {@render list()}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (A focusable separator implements the ARIA window splitter pattern.) -->
  <div
    class="pane-divider"
    role="separator"
    tabindex="0"
    aria-label="Resize preview"
    aria-orientation={sideBySide ? 'vertical' : 'horizontal'}
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
    ondblclick={() => setProportion(sideBySide ? 0.6 : 0.72)}
  ><span></span></div>
  {@render preview()}
</div>
