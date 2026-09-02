import './app.css'
import { mount } from 'svelte'
import Palette from './Palette.svelte'
import { PaletteState } from './palette-state.svelte'

const target = document.getElementById('app')
if (target === null) throw new Error('cairn: index.html is missing its #app mount point')
target.textContent = ''

const state = new PaletteState({
  api: window.cairn,
  // The renderer cannot import `systemClock` from @cairn/protocol (that would drag node:crypto into
  // the bundle), so this is the same two lines, inline. Tests inject createTestClock() instead.
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const handle = window.setTimeout(fn, ms)
      return () => window.clearTimeout(handle)
    },
  },
})

void state.start()
mount(Palette, { target, props: { palette: state } })
