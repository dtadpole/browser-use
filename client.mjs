import { spawn } from 'node:child_process'
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { processAlive, proxyArgs, stateDir } from './chrome.mjs'
import { daemonLogPath, request, SESSION_SOCKET, SESSION_STATE } from './host.mjs'

/**
 * The command-line side of the session host: is one running, start one, call a tool, stop it.
 *
 * All of it exists so that separate commands share one browser. Every decision here is about a failure
 * mode a client meets in practice: a state file whose host is dead, a host that starts but never
 * answers, a host owned by a different state directory, and a log a person can read when the browser
 * never came up.
 */

/** The command that starts a host, relative to this file. */
function cliPath() {
  return fileURLToPath(new URL('./cli.mjs', import.meta.url))
}

/** This checkout (the repository root, where this file lives), which is the working directory a host is started from. */
function repositoryRoot() {
  return fileURLToPath(new URL('./', import.meta.url))
}

/** The state file's contents, or `undefined` when there is no host on record. */
export function readState(dir = stateDir()) {
  const path = join(dir, SESSION_STATE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Ask a running host whether it is alive, with a short leash. */
export async function ping(state, timeoutMs = 2_000) {
  if (state === undefined) return undefined
  try {
    const answer = await request(state.socket, { id: 0, tool: '__ping' }, timeoutMs)
    return answer.ok === true ? answer.result : undefined
  } catch {
    return undefined
  }
}

/** The live host for this state directory, or `undefined`. */
export async function liveHost(dir = stateDir()) {
  const state = readState(dir)
  if (state === undefined) return undefined
  const health = await ping(state)
  return health === undefined ? undefined : { state, health }
}

/** How long a start may take before it is called a failure: a cold Chrome start, plus its sandbox retry. */
const START_TIMEOUT_MS = 60_000

/** The file whose exclusive creation makes one process at a time the one starting a state directory's host. */
export const START_LOCK = 'start.lock'

/** An empty lock (its taker died between creating and writing it) older than this is stale. */
const EMPTY_LOCK_STALE_MS = 10_000

/**
 * Take a state directory's start lock (Review A on PR #572, A-M1: two first calls on one state directory each started
 * a host, and the second cleared the first browser's profile locks). The lock is a file created exclusively that holds
 * the taker's pid; one whose pid is dead, or an empty one older than ten seconds, is stale and replaced. Returns the
 * release function, or `undefined` when a live holder kept it for `timeoutMs`. Release removes only this taker's lock.
 */
export async function acquireStartLock(dir, { timeoutMs = START_TIMEOUT_MS, alive = processAlive, pid = process.pid, pollMs = 100 } = {}) {
  const path = join(dir, START_LOCK)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(path, 'wx')
      try {
        writeSync(fd, String(pid))
      } finally {
        closeSync(fd)
      }
      return () => {
        try {
          if (readFileSync(path, 'utf8').trim() === String(pid)) rmSync(path, { force: true })
        } catch {
          // Already gone.
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    let text = ''
    let age = 0
    try {
      text = readFileSync(path, 'utf8').trim()
      age = Date.now() - statSync(path).mtimeMs
    } catch {
      continue // released between the two calls: try again at once
    }
    const holder = Number(text)
    const stale = text.length > 0 ? !alive(holder) : age > EMPTY_LOCK_STALE_MS
    if (stale) {
      takeOverStaleLock(path, text, pid)
      continue
    }
    if (Date.now() >= deadline) return undefined
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs))
  }
}

/**
 * Remove a lock judged stale, atomically (Review A on PR #582, A-M2): two waiters may judge the same dead holder's lock
 * stale, and a plain remove by the slower one could delete the lock the faster one has just created. The lock is
 * renamed aside instead - only one rename of a given file succeeds - and the moved file is removed only if it still
 * holds what was judged; a fresh lock moved by mistake is put back with a link, which never replaces a lock taken
 * meanwhile.
 */
export function takeOverStaleLock(path, judged, pid = process.pid) {
  const aside = `${path}.stale-${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    renameSync(path, aside)
  } catch {
    return false // another waiter moved or removed it first: try 'wx' again
  }
  let moved = ''
  try {
    moved = readFileSync(aside, 'utf8').trim()
  } catch {
    // unreadable: treat as the judged lock
    moved = judged
  }
  if (moved !== judged) {
    try {
      linkSync(aside, path) // a fresh lock taken between the judgement and the rename goes back
    } catch {
      // the slot is taken again; that holder owns it now
    }
  }
  rmSync(aside, { force: true })
  return moved === judged
}

/**
 * Start a host in the background and wait until it answers.
 *
 * The daemon is detached and writes its output to `daemon.log`; when the start fails, the log's tail is
 * what the caller is shown, because "it did not start" without the browser's own words is not something
 * a person can act on.
 */
export async function startHostProcess(options = {}) {
  const dir = options.stateDir ?? stateDir()
  // A named session's directory is created by this start, because the log it writes is opened first.
  mkdirSync(dir, { recursive: true })
  const release = await acquireStartLock(dir, { timeoutMs: options.timeoutMs ?? START_TIMEOUT_MS })
  if (release === undefined) {
    throw new Error(`another process has been starting the browser of ${dir} for longer than ${options.timeoutMs ?? START_TIMEOUT_MS}ms (${START_LOCK})`)
  }
  try {
    // Another process may have started the host while this one waited for the lock: join it, never start a second -
    // unless it runs with another proxy than this call asks for (Review A on PR #582, A-M3).
    const live = await liveHost(dir)
    if (live !== undefined) {
      const mismatch = proxyMismatch(proxyArgs(options), live.health, dir)
      if (mismatch !== undefined) throw new Error(mismatch)
      return live
    }
    const recorded = readState(dir)
    if (!recordIsStale(recorded)) {
      throw new Error(`the browser host of ${dir} (pid ${recorded.pid}) is running but did not answer; stop it ` +
        `(cli.mjs stop, or kill ${recorded.pid}) before another starts on its profile`)
    }
    // A state file whose host process is gone names a host that is gone; it must not block the start.
    rmSync(join(dir, SESSION_SOCKET), { force: true })
    rmSync(join(dir, SESSION_STATE), { force: true })
    return await spawnHost(options, dir)
  } finally {
    release()
  }
}

/**
 * Whether a host record may be removed: there is none, it names no pid, or its process is gone. A record whose
 * process is alive is a host that did not answer, and starting a second browser on its profile would corrupt it.
 */
export function recordIsStale(state, alive = processAlive) {
  return state === undefined || !Number.isInteger(state.pid) || !alive(state.pid)
}

/** Start the host process for `dir` and wait until it answers; the caller holds the start lock. */
async function spawnHost(options, dir) {
  const log = daemonLogPath(dir)
  const logFd = openSync(log, 'a')
  const args = daemonArgs(options, dir)
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, HEDDLE_BROWSER_HOME: dir },
  })
  closeSync(logFd)
  child.unref()

  let exited
  child.once('exit', (code) => {
    exited = code
  })

  const deadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS)
  const socketPath = join(dir, SESSION_SOCKET)
  for (;;) {
    const state = readState(dir)
    if (state !== undefined && existsSync(socketPath)) {
      const health = await ping(state)
      if (health !== undefined) return { state, health }
    }
    if (exited !== undefined) {
      throw new Error(`the browser session host exited before it was ready (code ${String(exited)}).\n${tailLog(log)}`)
    }
    if (Date.now() > deadline) {
      // A host that hung is not one the next command should find; removing the record is honest.
      rmSync(join(dir, SESSION_STATE), { force: true })
      throw new Error(`the browser session host did not become ready within ${options.timeoutMs ?? START_TIMEOUT_MS}ms.\n${tailLog(log)}`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
}

/**
 * The argv of the session host process for a start's options. The proxy options travel as flags; without them the
 * daemon inherits HEDDLE_BROWSER_PROXY_PAC and HEDDLE_BROWSER_PROXY_SERVER from this environment.
 */
export function daemonArgs(options, dir) {
  const args = [options.cliPath ?? cliPath(), '__daemon', `--state=${dir}`]
  if (options.headless === true) args.push('--headless')
  if (typeof options.profile === 'string' && options.profile.length > 0) args.push(`--profile=${options.profile}`)
  if (typeof options.binary === 'string' && options.binary.length > 0) args.push(`--binary=${options.binary}`)
  if (Number.isFinite(options.width)) args.push(`--width=${options.width}`)
  if (Number.isFinite(options.height)) args.push(`--height=${options.height}`)
  if (typeof options.proxyPac === 'string' && options.proxyPac.length > 0) args.push(`--proxy-pac=${options.proxyPac}`)
  if (typeof options.proxyServer === 'string' && options.proxyServer.length > 0) args.push(`--proxy-server=${options.proxyServer}`)
  if (options.disableProxyExtensions === true) args.push('--disable-proxy-extensions')
  if (typeof options.extensionsPolicy === 'string' && options.extensionsPolicy !== 'keep') args.push(`--extensions=${options.extensionsPolicy}`)
  if (options.protectedProfile === true) args.push('--protected')
  if (typeof options.proxyCheckUrl === 'string' && options.proxyCheckUrl.length > 0) args.push(`--proxy-check-url=${options.proxyCheckUrl}`)
  if (typeof options.proxyCheckVia === 'string' && options.proxyCheckVia.length > 0) args.push(`--proxy-check-via=${options.proxyCheckVia}`)
  if (typeof options.profileName === 'string' && options.profileName.length > 0) args.push(`--profile-name=${options.profileName}`)
  return args
}

/** The last lines of the daemon's log, for an error message. */
export function tailLog(path, lines = 12) {
  try {
    const text = readFileSync(path, 'utf8').trimEnd()
    if (text.length === 0) return '(the daemon wrote nothing)'
    return text.split('\n').slice(-lines).join('\n')
  } catch {
    return '(there is no daemon log)'
  }
}

/**
 * Why a live host cannot serve a call that asks for a proxy, or `undefined` when it can (Review A on PR #582, A-M1):
 * a proxy is set when a browser starts, so a host started with another one (or none) would serve the call without the
 * proxy it asked for. A call that asks for none is served by any host.
 */
export function proxyMismatch(requested, health, dir) {
  if (requested.length === 0) return undefined
  const running = Array.isArray(health?.proxy) ? health.proxy : []
  if (running.length === requested.length && running.every((flag, index) => flag === requested[index])) return undefined
  return `the browser of ${dir} is running with proxy [${running.join(' ') || 'none'}], not [${requested.join(' ')}]; ` +
    'stop it first (cli.mjs --session=NAME stop) or use another --session'
}

/** The running host, starting one when there is none. */
export async function ensureHost(options = {}) {
  const dir = options.stateDir ?? stateDir()
  const headless = options.headless ?? process.env.HEDDLE_BROWSER_HEADLESS === '1'
  options = { ...options, headless }
  const requested = proxyArgs(options)
  const live = await liveHost(dir)
  if (live !== undefined) {
    const mismatch = proxyMismatch(requested, live.health, dir)
    if (mismatch !== undefined) throw new Error(mismatch)
    return live
  }
  // The stale-record cleanup happens inside startHostProcess, under the start lock: done here, it could delete the
  // records of a host another process is starting at this moment.
  return startHostProcess({ ...options, stateDir: dir })
}

/** Call one browser tool on the shared session, starting the session when needed. */
export async function callTool(tool, args = {}, options = {}) {
  const { state } = await ensureHost(options)
  const answer = await request(state.socket, { id: Date.now(), tool, args }, options.timeoutMs ?? 180_000)
  if (answer.ok !== true) throw new Error(answer.error?.message ?? 'the browser tool failed')
  return answer.result
}

/** Ask the running host for its health, or report that none is running. */
export async function status(options = {}) {
  const dir = options.stateDir ?? stateDir()
  const live = await liveHost(dir)
  if (live === undefined) return { running: false, state: readState(dir) }
  return { running: true, ...live }
}

/** Stop the running host, and clean up a state record left by one that already died. */
export async function stopHost(options = {}) {
  const dir = options.stateDir ?? stateDir()
  const state = readState(dir)
  if (state !== undefined) {
    try {
      await request(state.socket, { id: Date.now(), tool: '__shutdown' }, 5_000)
    } catch {
      // The host is already gone; removing its record is the rest of stopping it.
    }
  }
  rmSync(join(dir, SESSION_SOCKET), { force: true })
  rmSync(join(dir, SESSION_STATE), { force: true })
  return { stopped: true }
}
