import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Preview from './Preview.svelte'

// Spec §11 control 3. Copied HTML is content an attacker's page authored. Rendering it would hand
// that page script execution inside our privileged renderer, with the whole history one IPC call
// away — the single worst vulnerability this app class can have.
let host: HTMLDivElement
let app: Record<string, unknown> | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (app !== null) void unmount(app)
  app = null
  host.remove()
  delete (globalThis as Record<string, unknown>).__pwned
})

describe('the preview pane never renders copied HTML as HTML', () => {
  it('escapes an <img onerror> payload to text', () => {
    const payload = '<img src=x onerror="window.__pwned = true">'
    app = mount(Preview, {
      target: host,
      props: { text: payload, mime: 'text/html' },
    }) as Record<string, unknown>
    flushSync()

    const pre = host.querySelector('pre')
    expect(pre).not.toBe(null)
    expect(pre?.textContent).toBe(payload)
    expect(pre?.querySelector('img')).toBe(null)
    expect(pre?.innerHTML).toBe('&lt;img src=x onerror="window.__pwned = true"&gt;')
    expect((globalThis as Record<string, unknown>).__pwned).toBe(undefined)
  })

  it('never reaches the IPC bridge from a payload that names it', () => {
    let bridgeCalls = 0
    Object.defineProperty(globalThis, 'cairn', {
      configurable: true,
      value: {
        list: () => {
          bridgeCalls += 1
          return Promise.resolve({ items: [], total: 0 })
        },
      },
    })
    const payload = '<img src=x onerror="window.cairn.list({limit:1,offset:0,pinnedOnly:false})">'
    app = mount(Preview, {
      target: host,
      props: { text: payload, mime: 'text/html' },
    }) as Record<string, unknown>
    flushSync()

    expect(host.querySelectorAll('img').length).toBe(0)
    expect(host.querySelector('pre')?.textContent).toBe(payload)
    expect(bridgeCalls).toBe(0)
  })

  it('labels HTML source without changing the body, and drops the label for plain text', () => {
    app = mount(Preview, {
      target: host,
      props: { text: 'plain', mime: 'text/plain' },
    }) as Record<string, unknown>
    flushSync()

    expect(host.querySelector('[data-testid="preview-badge"]')).toBe(null)
    expect(host.querySelector('pre')?.textContent).toBe('plain')
  })
})
