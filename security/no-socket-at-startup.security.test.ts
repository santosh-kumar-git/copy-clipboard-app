import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { findInSources, formatHits, sourceFiles } from './source-scan'

// Spec §11 control 1: no telemetry, no analytics and no network egress of any kind before the
// user opens the Pair screen — which does not exist until M6. Nothing may bind or dial a socket.
const PRODUCT_ROOTS = ['packages', 'apps/desktop', 'tools']
const SOCKET_APIS = [
  'net.createServer',
  'http.createServer',
  'https.createServer',
  'dgram.createSocket',
  'tls.createServer',
  'WebSocketServer',
  'bonjour',
  'fetch(',
  'https.request',
  'http.request',
  'XMLHttpRequest',
]
const HANDLE_RE = /TCPSERVERWRAP|TCPWRAP|UDPWRAP/i

describe('no socket at startup', () => {
  it('scans a non-empty set of product source files', () => {
    expect(sourceFiles(PRODUCT_ROOTS).length).toBeGreaterThan(0)
  })

  it('names no socket-creating API on any non-comment line of product source', () => {
    for (const api of SOCKET_APIS) {
      expect(formatHits(findInSources(api, PRODUCT_ROOTS)), `banned API: ${api}`).toBe('')
    }
  })

  it('holds no TCP or UDP handle in this process', () => {
    expect(process.getActiveResourcesInfo().filter((h) => HANDLE_RE.test(h))).toEqual([])
  })

  it('would notice a listening socket if one appeared', () => {
    // The positive control runs in a CHILD process: a closed server handle lingers in
    // getActiveResourcesInfo() for the rest of the tick, which would poison the assertion above.
    const src =
      "const net=require('node:net');const s=net.createServer();" +
      "s.listen(0,'127.0.0.1',()=>{console.log(JSON.stringify(process.getActiveResourcesInfo()));s.close();});"
    const out = execFileSync(process.execPath, ['-e', src], { encoding: 'utf8' })
    expect((JSON.parse(out) as string[]).some((h) => HANDLE_RE.test(h))).toBe(true)
  })
})
