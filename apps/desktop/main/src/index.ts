import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { DATA_DIR_NAME } from '@cairn/protocol'

// Must run before anything reads app.getPath('userData'): without it Electron 44 uses
// ~/Library/Application Support/Electron, a directory shared with every unbranded Electron app.
app.setName(DATA_DIR_NAME)

function createPaletteWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 420,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      enableBlinkFeatures: '',
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  })

  // Every byte this window displays came off the clipboard, so a navigation or a popup is an
  // exfiltration channel. Both are denied unconditionally (spec §11 control 4).
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl !== undefined && devUrl !== '') {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  win.once('ready-to-show', () => {
    win.show()
  })
  return win
}

void app.whenReady().then(() => {
  createPaletteWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
