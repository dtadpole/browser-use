import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Helpers for this tool's verifiers: the three the browser checks use, taken from heddle's
 * `_tools_/verify-runner/lib.mjs` (heddle a4c9726) when the tool moved to reflection.
 *
 * - **A check that cannot judge says so.** `skipUnless` turns a missing prerequisite (no browser) into a
 *   labelled skip, which `run.mjs` counts as unjudged (exit `3`) rather than as a pass.
 * - **Fixtures never go under the reflection checkout.** heddle kept them under its ignored `.heddle-tmp/`
 *   because its plugin loader needed in-tree paths; the reflection checkout is shared by many writers, so
 *   they go under `~/.browser-use/verify/`, beside the tool's state.
 * - **A fixture path must stay short.** A session check puts the host's Unix socket inside its fixture,
 *   and macOS caps a socket path at 104 bytes. Measured 2026-10-28: under `os.tmpdir()`
 *   (`/var/folders/.../T/`) the path was 111 bytes and `listen()` failed with `EINVAL`.
 *   `BROWSER_USE_SCRATCH` moves them; keep it short.
 */

/** Where generated fixtures live. */
export const scratchRoot = process.env.BROWSER_USE_SCRATCH || join(homedir(), '.browser-use', 'verify')

const scratchCounter = { value: 0 }

/** This run's own token, so two runs of the same check cannot share a fixture. */
const runToken = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`

/** A fresh, empty fixture directory under the scratch root, named for this process. */
export function fixtureDir(label) {
  scratchCounter.value += 1
  const dir = join(scratchRoot, `${label}-${runToken}-${scratchCounter.value}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Remove a fixture directory and everything in it; absent is fine. */
export function removeDir(path) {
  rmSync(path, { recursive: true, force: true })
}

/** Skip the test with `reason` unless `condition` holds; returns whether it holds. */
export function skipUnless(context, condition, reason) {
  if (!condition) context.skip(reason)
  return Boolean(condition)
}
