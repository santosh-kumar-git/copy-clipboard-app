// Spike (b), spec §8: when the Swift helper asks for Accessibility, does TCC attribute the request
// to the helper binary or to the parent Electron app? Run the same probe both ways and compare the
// app name in the dialog and in System Settings > Privacy & Security > Accessibility.
// M1 calls none of this: NSPasteboard reads, NSWorkspace attribution and Carbon hotkeys are all
// permission-free (spec §6), so M1 must work with AXIsProcessTrusted() === false either way.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { app } = require('electron')

app.whenReady().then(() => {
  const probe = join(__dirname, 'build', 'ax-probe')
  console.log(`parent pid=${process.pid} name=${app.getName()} path=${app.getPath('exe')}`)
  try {
    const out = execFileSync(probe, ['--prompt'], {
      encoding: 'utf8',
      env: { ...process.env, CAIRN_SPIKE_PARENT: app.getName() },
    })
    console.log(out.trim())
  } catch (e) {
    console.log(`probe failed: ${e.message}`)
  }
  console.log('Read the dialog title, then DENY. Record which app name it named.')
  setTimeout(() => app.quit(), 30_000)
})
