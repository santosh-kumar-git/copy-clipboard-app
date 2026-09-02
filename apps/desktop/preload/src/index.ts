// The renderer's only bridge to the main process.
//
// It exposes a FIXED, ENUMERATED set of methods and never a generic invoke(channel, ...) —
// spec §11 control 4. The twelve M1 methods land with the IPC task; this file exists from day 0
// because a sandboxed preload must be CJS on Electron 44 (an ESM preload fails the page load with
// ERR_FAILED), and that build target has to be real before anything depends on it.
export {}
