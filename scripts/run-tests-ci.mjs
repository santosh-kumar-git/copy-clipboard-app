#!/usr/bin/env node
// CI-only wrapper around `vitest run`.
//
// Observed on the runner: every test file reports ✓ and then the job sits there with no summary
// line. The work finishes; something keeps the process alive during teardown. It does not reproduce
// locally, including with CI=true, so the only way to learn what is holding it open is to look while
// it is stuck.
//
// This is a Node wrapper rather than a shell one on purpose. The shell version killed the watchdog
// subshell, which does NOT kill the `sleep` inside it, and that orphaned `sleep` inherits the step's
// stdout — so GitHub kept waiting on the pipe and the step hung even when the tests were fine. A
// second hang layered on the one being diagnosed. Here the timer is cleared and `process.exit` is
// called explicitly, so nothing outlives the decision.
import { execSync, spawn } from 'node:child_process'

const TIMEOUT_MS = Number(process.env['CAIRN_TEST_TIMEOUT_MS'] ?? 480_000)

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd()
  } catch {
    return `(failed: ${cmd})`
  }
}

// `detached` puts vitest in its OWN process group so the whole tree can be signalled at once.
// Measured: `child.kill()` only reaps the `npx` shim and leaves the vitest processes running, and
// those survivors inherit the step's stdout — which is precisely the hang this script exists to
// avoid re-creating.
const child = spawn('npx', ['vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  detached: true,
})

const killTree = () => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

const timer = setTimeout(() => {
  // GitHub folds these, and ::error:: surfaces in the run summary rather than only the log.
  console.error(`::error::vitest produced no summary within ${TIMEOUT_MS / 1000}s — dumping state`)
  console.error('--- process tree ---')
  console.error(sh("ps -Ao pid,ppid,stat,etime,command | grep -iE 'vitest|node|swift|Electron|cairn' | grep -v grep"))
  for (const pid of sh('pgrep -f vitest').split('\n').filter(Boolean)) {
    console.error(`--- open files, pid ${pid} ---`)
    console.error(sh(`lsof -p ${pid} | tail -30`))
    console.error(`--- stack sample, pid ${pid} ---`)
    // Where it is actually parked: a run loop, a socket read, a futex, a child wait.
    console.error(sh(`sample ${pid} 2 -mayDie 2>/dev/null | head -60`))
  }
  killTree()
  process.exit(1)
}, TIMEOUT_MS)

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (signal !== null) {
    console.error(`vitest terminated by ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})

child.on('error', (e) => {
  clearTimeout(timer)
  console.error(`could not start vitest: ${e.message}`)
  process.exit(1)
})
