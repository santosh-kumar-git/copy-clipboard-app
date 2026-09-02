// Spike (a), spec §8: does BrowserWindow({type:'panel'}) still yield a real NSPanel on Electron 44?
// Electron's own typings declare `type?: string`, so the compiler will never answer this — only
// behaviour will. Run it three ways and compare:
//   PANEL=1 POLICY=accessory  npx electron spikes/electron-panel
//   PANEL=0 POLICY=accessory  npx electron spikes/electron-panel
//   PANEL=1 POLICY=regular    npx electron spikes/electron-panel
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

const PANEL = process.env.PANEL !== '0'
const POLICY = process.env.POLICY === 'regular' ? 'regular' : 'accessory'
const PROBE = join(__dirname, 'build', 'frontmost')

function observe(label) {
  try {
    const out = execFileSync(PROBE, ['electron'], { encoding: 'utf8' })
    console.log(`--- ${label}\n${out.trim()}`)
  } catch (e) {
    console.log(`--- ${label}: probe failed: ${e.message}`)
  }
}

app.whenReady().then(() => {
  app.setActivationPolicy(POLICY)
  const win = new BrowserWindow({
    width: 620,
    height: 140,
    show: false,
    frame: false,
    ...(PANEL ? { type: 'panel' } : {}),
    vibrancy: 'hud',
    visualEffectState: 'active',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') console.log(`key reached the window: ${input.key}`)
  })
  win.loadFile(join(__dirname, 'index.html'))

  console.log(`PANEL=${PANEL} POLICY=${POLICY} — click into TextEdit now. Showing in 5s.`)
  setTimeout(() => {
    observe('before show')
    win.showInactive()
    setTimeout(() => {
      observe('after showInactive()')
      win.focus()
      setTimeout(() => observe('after focus()'), 800)
    }, 800)
  }, 5000)
})
