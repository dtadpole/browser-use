import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import http from 'node:http'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { connect } from './cdp.mjs'

/**
 * Finding, starting and stopping the browser.
 *
 * The tool ships with no driver package: Chrome's own DevTools endpoint is the interface, and this
 * file owns the part that is about *the machine* rather than about the protocol — where the binary
 * lives, which profile it gets, and how a start is known to have succeeded.
 */

/**
 * Where the usual browsers live on this platform, in preference order.
 *
 * The environment variable comes first because it is the only one that works on a machine whose
 * browser is somewhere else, and it is also how a check pins its own binary.
 */
export const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/** The first browser binary this machine has, or `undefined`. */
export function browserPath(override) {
  if (override !== undefined && override.length > 0) return override
  for (const variable of ['HEDDLE_BROWSER', 'CHROME_PATH']) {
    const value = process.env[variable]
    if (value !== undefined && value.length > 0 && existsSync(value)) return value
  }
  return CANDIDATES.find((candidate) => existsSync(candidate))
}

/** Whether a browser is available, so a caller can report unjudged rather than failed. */
export function browserAvailable(override) {
  return browserPath(override) !== undefined
}

/**
 * The directory this tool keeps its machine-local state in.
 *
 * A profile is deliberately **not** a temporary directory: a login done once in a visible window is
 * reused by every later call, which is the behaviour the harness's own browser has and the reason a
 * caller can be asked to sign in by hand. In reflection it lives in the **home directory**
 * (`~/.browser-use/browser/`), never under the checkout: a profile holds logins and cookies, and the
 * reflection checkout is shared by many writers and has no ignore rule for it (heddle kept it under
 * `.heddle-tmp/`, which heddle ignores). `HEDDLE_BROWSER_HOME` moves it, so a check or a second owner
 * can have a browser of its own; the variable names are kept from heddle so an existing profile such
 * as `~/.heddle-browser` stays reachable.
 */
export function stateDir() {
  const fromEnvironment = process.env.HEDDLE_BROWSER_HOME
  const base = fromEnvironment !== undefined && fromEnvironment.length > 0 ? fromEnvironment : join(homedir(), '.browser-use', 'browser')
  /**
   * A **named session is a browser of its own**: its own process, its own profile, its own tabs. There is
   * no way for two sessions sharing one Chrome to keep their pages apart in `list_pages` or their
   * selected page apart in a tool call that names none, so isolation is per session rather than per page.
   * `HEDDLE_BROWSER_SESSION` (or `--session=`) selects one; without it, the machine's default session is
   * what a person running the command line by hand gets.
   */
  const session = process.env.HEDDLE_BROWSER_SESSION
  if (session === undefined || session.length === 0) return base
  const safe = session.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return join(base, 'sessions', safe.length > 0 ? safe : 'unnamed')
}

/**
 * Where the default profile lies: under stateDir(), so a named session has its own
 * (`HEDDLE_BROWSER_HOME/sessions/NAME/chrome-profile`). `cli.mjs start` reports this path; it once joined
 * HEDDLE_BROWSER_HOME itself and so named the default session's profile for every named session.
 */
export function defaultProfilePath() {
  return join(stateDir(), 'chrome-profile')
}

/** The profile directory, created on demand. */
export function profileDir() {
  const dir = defaultProfilePath()
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A proxy server item: [http=|https=|ftp=|socks=][scheme://]host[:port], or direct://. */
const PROXY_ITEM =
  /^(?:(?:http|https|ftp|socks)=)?(?:direct:\/\/|(?:(?:https?|socks[45]?|quic):\/\/)?(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?)$/

/** A setting's value, from the option or else the variable; an empty or blank value counts as unset. */
function setting(value, variable, env) {
  const chosen = value ?? env[variable]
  return typeof chosen === 'string' && chosen.trim().length > 0 ? chosen.trim() : undefined
}

/**
 * Chrome's proxy flags for one start (owner request 2026-10-29: open the GHE web page through the PAC served at
 * `http://127.0.0.1:18085/site.pac`, leaving the owner's Chrome and the system proxy alone).
 *
 * The settings are `options.proxyPac` and `options.proxyServer` (the `--proxy-pac=` and `--proxy-server=` options
 * of `cli.mjs start`), else `HEDDLE_BROWSER_PROXY_PAC` and `HEDDLE_BROWSER_PROXY_SERVER`; an option wins over its
 * variable. A PAC URL must be `http:` or `https:`: Chrome ignores a `file:` PAC (measured 2026-10-29), so taking one
 * would browse directly without a word. A server is Chrome's `--proxy-server` value: `[scheme://]host[:port]`, or a
 * `;`-separated list of `http=`/`https=`/`ftp=`/`socks=` entries. **When both are set the PAC wins** and the
 * server is not passed: the PAC is the narrower setting (it proxies only the hosts it names, as site.pac does), and
 * Chrome itself prefers `--proxy-pac-url` when given both. An invalid value throws, so a misspelt proxy fails the
 * start instead of going direct.
 */
export function proxyArgs(options = {}, env = process.env) {
  const pac = setting(options.proxyPac, 'HEDDLE_BROWSER_PROXY_PAC', env)
  const server = setting(options.proxyServer, 'HEDDLE_BROWSER_PROXY_SERVER', env)
  if (pac !== undefined) {
    let url
    try {
      url = new URL(pac)
    } catch {
      throw new Error(`the proxy PAC '${pac}' is not a URL`)
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || /\s/.test(pac)) {
      throw new Error(`the proxy PAC '${pac}' must be an http: or https: URL (Chrome ignores a file: PAC)`)
    }
    return [`--proxy-pac-url=${pac}`]
  }
  if (server !== undefined) {
    for (const item of server.split(';')) {
      const match = PROXY_ITEM.exec(item)
      const port = match?.[1] === undefined ? undefined : Number(match[1])
      if (match === null || (port !== undefined && (port < 1 || port > 65535))) {
        throw new Error(`the proxy server '${server}' is not [scheme://]host[:port] or a ';' list of them ('${item}')`)
      }
    }
    return [`--proxy-server=${server}`]
  }
  return []
}

/** Fetch one JSON document from the browser's HTTP side. */
function httpJson(port, path, timeoutMs = 2_000) {
  return new Promise((resolvePromise, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body += chunk.toString()
      })
      response.on('end', () => {
        try {
          resolvePromise(JSON.parse(body))
        } catch (error) {
          reject(new Error(`the browser answered '${path}' with something that is not JSON: ${String(error)}`))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error(`the browser did not answer '${path}' within ${timeoutMs}ms`)))
    request.on('error', reject)
  })
}

/**
 * Marker Chrome prints when the **outer** environment refused its own sandbox.
 *
 * Measured on this machine: Chrome's zygote could not initialize its sandbox (the harness confines
 * every process it starts), so the renderer crashed the moment a page was attached, while the
 * browser itself had started and printed an endpoint. Re-running the same browser with
 * `--no-sandbox` — Chrome's sandbox, not the host's — makes it usable, and this is the only
 * environment signal that distinguishes the two cases.
 */
const SANDBOX_FAILURE = /sandbox initialization failed|failed to initialize sandbox|SUID sandbox helper/i

/** Whether process `pid` is alive on this machine (a process another user owns counts as alive). */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Who holds a profile's `SingletonLock`, which Chrome writes as a link to `<hostname>-<pid>`: `undefined` when there
 * is no lock, else `{ host, pid, foreign }`, foreign meaning another machine or a target that cannot be read.
 */
export function singletonHolder(profile, host = hostname()) {
  let target
  try {
    target = readlinkSync(join(profile, 'SingletonLock'))
  } catch {
    return undefined
  }
  const cut = target.lastIndexOf('-')
  const pid = cut < 0 ? Number.NaN : Number(target.slice(cut + 1))
  if (!Number.isInteger(pid)) return { host: target, pid: undefined, foreign: true }
  return { host: target.slice(0, cut), pid, foreign: target.slice(0, cut) !== host }
}

/**
 * Remove the lock files a killed browser leaves behind, which block the next start on that profile - only when no
 * live browser holds them (Review A on PR #572, A-M1: removing a live browser's files defeats Chrome's own
 * one-instance-per-profile guard, and two browsers then write one profile, such as the SSO login of
 * ~/.heddle-browser). A live or foreign holder keeps its files and the start that follows fails, saying why.
 * Returns whether the files were cleared.
 */
/** A process's command line, or undefined when it cannot be read. */
export function processCommand(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the live process `pid` is the browser of `profile`: `'yes'` when its command line names the profile in
 * `--user-data-dir`, `'no'` when it names only other directories, `'unknown'` when it cannot be judged - an
 * unreadable command line, no absolute `--user-data-dir` value. Both sides are resolved through links and `//`
 * (Review A on PR 2133, A-I1, and Review B, B-M1: a browser started under a link to the profile, compared with a start
 * naming the real path, read as stale, and its live lock would have been removed). A lock copied with a profile
 * (`cp -R` of ~/.heddle-browser/chrome-profile) names the original's browser, which names another directory: `'no'`
 * (Review B, B-I1).
 */
export function holdsProfile(pid, profile, command = processCommand) {
  const line = command(pid)
  if (line === undefined) return 'unknown'
  const real = (path) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)   // collapses '//', '.' and a trailing slash of a path that is gone
    }
  }
  const values = [...line.matchAll(/--user-data-dir=(\S+)/g)].map((m) => m[1])
  if (values.length === 0 || values.some((v) => !isAbsolute(v))) return 'unknown'
  return values.map(real).includes(real(profile)) ? 'yes' : 'no'
}

export function clearSingleton(profile, alive = processAlive, host = hostname(), command = processCommand) {
  const holder = singletonHolder(profile, host)
  // a live holder keeps its files only when it is this profile's browser; a lock copied from another profile names
  // that profile's browser, and Chrome would hand this start to it through the copied SingletonSocket
  if (holder !== undefined && (holder.foreign || (alive(holder.pid) && holdsProfile(holder.pid, profile, command) !== 'no'))) {
    return false
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      rmSync(join(profile, name), { force: true })
    } catch {
      // A file that cannot be removed is reported by the start that follows.
    }
  }
  return true
}

/**
 * Why a start on `profile` must not run because another browser holds it, or undefined. Chrome lets one process
 * own a profile: a second start with the same `--user-data-dir` hands its command line to the running one and
 * exits, so this start's flags - `--proxy-pac-url` among them - are dropped without a word (the [reflection]
 * Coordinator, 2026-10-29: fifteen stale processes held one profile and a PAC start went direct). A live holder on
 * this machine, or a lock this machine cannot judge, refuses the start; a dead holder's lock is cleared as before.
 */
export function profileHeld(profile, alive = processAlive, host = hostname(), command = processCommand) {
  const holder = singletonHolder(profile, host)
  if (holder === undefined) return undefined
  if (holder.foreign) {
    return `the profile ${profile} is locked by '${holder.host}', another machine or a lock that cannot be read; ` +
      'a start would hand its flags to that browser - use another HEDDLE_BROWSER_HOME or --profile'
  }
  // a dead holder, or a live process that is not this profile's browser (a lock copied with the profile), is a
  // stale lock the start clears; only this profile's own browser is named, and only it may be stopped
  if (!alive(holder.pid)) return undefined
  const holds = holdsProfile(holder.pid, profile, command)
  if (holds === 'no') return undefined
  if (holds === 'unknown') {
    return `the profile ${profile} is locked by a running process (pid ${holder.pid}) whose command line names no ` +
      `absolute --user-data-dir, so it cannot be told apart from this profile's browser; check that process before ` +
      `removing ${profile}/SingletonLock, or use another HEDDLE_BROWSER_HOME or --profile`
  }
  return `the profile ${profile} is held by a running browser (pid ${holder.pid}); a second start would hand its flags ` +
    `(a proxy among them) to that browser and drop them - stop it (\`cli.mjs stop\`, or kill ${holder.pid}) or use ` +
    'another HEDDLE_BROWSER_HOME or --profile'
}

/**
 * The extensions that set the proxy in a profile and are enabled: `[{ id, name }]`. An extension's proxy setting is
 * stored in the profile's `Default/Secure Preferences` (or `Preferences`) under `extensions.settings.<id>
 * .preferences.proxy`, and while the extension is enabled it outranks `--proxy-pac-url` and `--proxy-server` - Chrome
 * ranks an extension-controlled pref above the command line. Proxy Helper (abcdefghijklmnopabcdefghijklmnop) does this
 * in the SSO profile, so git.example.com answered 403 through a start that named the GHE PAC (the [reflection]
 * Coordinator, 2026-10-29 16.3xZ). A disabled extension (a non-empty `disable_reasons`) does not count.
 */
export function proxyExtensions(profile) {
  const found = []
  for (const name of ['Secure Preferences', 'Preferences']) {
    let data
    try {
      data = JSON.parse(readFileSync(join(profile, 'Default', name), 'utf8'))
    } catch {
      continue
    }
    const settings = data?.extensions?.settings
    if (settings === null || typeof settings !== 'object') continue
    for (const [id, entry] of Object.entries(settings)) {
      if (entry === null || typeof entry !== 'object') continue
      const sets = [entry.preferences, entry.regular_only_preferences]
        .some((prefs) => prefs !== null && typeof prefs === 'object' && Object.hasOwn(prefs, 'proxy'))
      if (!sets) continue
      const reasons = entry.disable_reasons
      const disabled = (Array.isArray(reasons) && reasons.length > 0) || (typeof reasons === 'number' && reasons !== 0) ||
        entry.state === 0
      if (!disabled && !found.some((e) => e.id === id)) found.push({ id, name: entry.manifest?.name ?? id })
    }
  }
  return found
}

/** The SSO-authenticated profiles nothing may change (~/.heddle-browser): an opt-in that alters one is refused. */
export function originalProfile(profile, home = homedir()) {
  const real = (path) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  const root = real(join(home, '.heddle-browser'))
  const target = real(profile)
  return target === root || target.startsWith(`${root}/`)
}

/** A start's extension policy: keep | disable-proxy-controllers | disable-all (--disable-proxy-extensions). */
export function extensionPolicy(options) {
  return options.extensionsPolicy ?? (options.disableProxyExtensions === true ? 'disable-all' : 'keep')
}

/**
 * The extension flags of a start. `disable-all` (`start --disable-proxy-extensions`) starts with
 * `--disable-extensions`; `disable-proxy-controllers` adds no flag - it disables only the extensions that hold the
 * proxy permission, through chrome.management once the browser is up (disableProxyControllers). Either one is refused
 * on a protected profile: only a copy, such as one made of ~/.heddle-browser for the GHE web page, is changed.
 *
 * The flag is no longer the guard: Chrome 156 kept Proxy Helper (installed by external preferences) enabled under
 * `--disable-extensions`, and its proxy outranked the GHE PAC (the [reflection] Coordinator, 2026-11-02 01:5xZ).
 */
export function extensionArgs(options, profile, home = homedir(), proxy = [], controllers = proxyExtensions) {
  const policy = extensionPolicy(options)
  if (policy === 'keep') return []
  if (policy === 'disable-proxy-controllers' && proxy.length === 0) return []
  if (options.protectedProfile === true || originalProfile(profile, home)) {
    throw new Error(`disabling extensions is refused on ${profile}, a protected profile (browser-use never changes ` +
      'it): start from a copy - `cli.mjs profile create NAME --clone=sso --extensions=disable-proxy-controllers`')
  }
  return policy === 'disable-all' ? ['--disable-extensions'] : []
}

/** How long the extension check lets Chrome finish loading extensions, and how it re-checks (#5608). */
export const CONTROLLER_TIMING = { settleMs: 2_000, maxSettleMs: 8_000, recheckMs: 1_500, rounds: 3 }

/**
 * The script that runs on chrome://extensions, the page that holds chrome.management. It first waits until the number
 * of installed extensions has not changed for `settleMs` (at most `maxSettleMs`): sideloaded extensions load after the
 * page answers, and a check that ran before Proxy Helper appeared left it enabled and GHE went direct (#5608, measured
 * 2026-11-08). Then it disables every enabled extension with the proxy permission, waits `recheckMs` and looks again,
 * up to `rounds` times, and reports what it disabled, what failed, what is still enabled and how long it waited.
 */
export function proxyControllerScript(timing = CONTROLLER_TIMING) {
  const t = { ...CONTROLLER_TIMING, ...timing }
  return `(async () => {
  const controls = (e) => e.enabled && (e.permissions || []).includes('proxy')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const begun = Date.now()
  let count = -1
  let stableSince = Date.now()
  for (;;) {
    const n = (await chrome.management.getAll()).length
    if (n !== count) { count = n; stableSince = Date.now() }
    if (Date.now() - stableSince >= ${t.settleMs} || Date.now() - begun >= ${t.maxSettleMs}) break
    await sleep(Math.min(250, ${t.settleMs}))
  }
  const disabled = []
  const failed = []
  for (let round = 0; round < ${t.rounds}; round += 1) {
    const now = (await chrome.management.getAll()).filter(controls)
    for (const e of now) {
      try { await chrome.management.setEnabled(e.id, false); disabled.push({ id: e.id, name: e.name }) }
      catch (err) { failed.push({ id: e.id, error: String((err && err.message) || err) }) }
    }
    await sleep(${t.recheckMs})
    if (!(await chrome.management.getAll()).some(controls)) break
  }
  const left = (await chrome.management.getAll()).filter(controls)
    .map((e) => ({ id: e.id, name: e.name, installType: e.installType }))
  return JSON.stringify({ disabled, failed, left, settledMs: Date.now() - begun })
})()`
}

/** The default script, kept under its old name for callers that read it. */
export const PROXY_CONTROLLER_SCRIPT = proxyControllerScript()

/** The longest the default script may run: settling, then every round's re-check, with a margin. */
export const CONTROLLER_SCRIPT_TIMEOUT_MS = CONTROLLER_TIMING.maxSettleMs +
  CONTROLLER_TIMING.rounds * CONTROLLER_TIMING.recheckMs + 10_000

/**
 * Disable the proxy-controlling extensions of a running browser and say what is left: `{ disabled, failed, left }`.
 * Opens chrome://extensions in a target of its own, waits for chrome.management, runs PROXY_CONTROLLER_SCRIPT and
 * closes the target. The change is the profile copy's own (Chrome saves it), so a later start finds them disabled -
 * until a `profile refresh` copies them enabled again, which is why every start runs it.
 */
export async function disableProxyControllers(running, { connectTo = connect, timeoutMs = 15_000,
  script = PROXY_CONTROLLER_SCRIPT, scriptTimeoutMs = CONTROLLER_SCRIPT_TIMEOUT_MS } = {}) {
  const connection = await connectTo(running.wsUrl)
  let targetId
  try {
    const created = await connection.send('Target.createTarget', { url: 'chrome://extensions' })
    targetId = created.result.targetId
    const sessionId = await connection.attach(targetId)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const probe = await connection.send('Runtime.evaluate', { expression: 'typeof chrome !== "undefined" && ' +
        'typeof chrome.management === "object"', returnByValue: true }, { sessionId })
      if (probe.result?.result?.value === true) break
      if (Date.now() > deadline) throw new Error(`chrome://extensions offered no chrome.management within ${timeoutMs}ms`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    const reply = await connection.send('Runtime.evaluate', { expression: script, awaitPromise: true,
      returnByValue: true }, { sessionId, timeoutMs: scriptTimeoutMs })
    const value = reply.result?.result?.value
    if (typeof value !== 'string') {
      throw new Error(`the extension check returned no report: ${JSON.stringify(reply.result?.exceptionDetails ?? reply.result)}`)
    }
    return JSON.parse(value)
  } finally {
    if (targetId !== undefined) await connection.send('Target.closeTarget', { targetId }).catch(() => {})
    connection.close()
  }
}

/**
 * After a proxied start under disable-proxy-controllers or disable-all: disable the proxy controllers and verify none
 * is left enabled; one that is left fails the start loudly, its browser stopped, since its proxy would outrank the
 * start's. Returns the extensions it disabled.
 */
export async function enforceProxyPolicy(running, options, proxy, { disable = disableProxyControllers, stop = stopChrome } = {}) {
  const policy = extensionPolicy(options)
  if (policy === 'keep' || proxy.length === 0) return []
  let report
  try {
    report = await disable(running)
  } catch (error) {
    await stop(running)
    throw new Error(`the start could not check its extensions (${error instanceof Error ? error.message : String(error)}); ` +
      'an extension with the proxy permission might outrank the start\'s proxy, so the browser was stopped')
  }
  if (report.left.length > 0) {
    await stop(running)
    const named = report.left.map((e) => `${e.name} (${e.id}, ${e.installType})`).join(', ')
    const why = report.failed.map((f) => `${f.id}: ${f.error}`).join('; ')
    throw new Error(`still enabled after disabling it: ${named}${why ? ` (${why})` : ''} - its proxy outranks ` +
      `${proxy.join(' ')}, so the browser was stopped; disable it by hand on chrome://extensions in this copy`)
  }
  return report.disabled
}

/**
 * Load `url` in a target of its own and report how the document came back: `{ url, status, remote, server }`, or
 * `{ error }` when it failed to load. Chrome reports the **proxy's** address as `remote` for a proxied load and the
 * origin's for a direct one (measured 2026-11-08: GHE through the PAC answered from 127.0.0.1:18080, example.com from
 * its own address), so `remote` is what the browser really did - whatever the flags, extensions or system say.
 */
export async function probeRoute(running, url, { connectTo = connect, timeoutMs = 20_000 } = {}) {
  const connection = await connectTo(running.wsUrl)
  let targetId
  try {
    const created = await connection.send('Target.createTarget', { url: 'about:blank' })
    targetId = created.result.targetId
    const sessionId = await connection.attach(targetId)
    const outcome = new Promise((resolvePromise) => {
      const timer = setTimeout(() => done({ error: `no document within ${timeoutMs}ms` }), timeoutMs)
      const removers = []
      const done = (value) => {
        clearTimeout(timer)
        for (const remove of removers) remove()
        resolvePromise(value)
      }
      removers.push(connection.on('Network.responseReceived', (params, message) => {
        if (message?.sessionId !== sessionId || params.type !== 'Document') return
        const r = params.response ?? {}
        const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
        done({ url: r.url, status: r.status, remote: formatRemote(r.remoteIPAddress, r.remotePort),
          server: headers.server ?? '' })
      }))
      removers.push(connection.on('Network.loadingFailed', (params, message) => {
        if (message?.sessionId !== sessionId || params.type !== 'Document') return
        done({ error: params.errorText ?? 'the document failed to load' })
      }))
    })
    await connection.send('Network.enable', {}, { sessionId })
    // a cached answer may carry no remote address at all (Review A on #5633, A-M1): load it from the network
    await connection.send('Network.setCacheDisabled', { cacheDisabled: true }, { sessionId })
    await connection.send('Page.navigate', { url }, { sessionId })
    const result = await outcome
    await connection.send('Page.stopLoading', {}, { sessionId }).catch(() => {})
    return result
  } finally {
    if (targetId !== undefined) await closeTargetSurely(connection, targetId)
    connection.close()
  }
}

/**
 * Close a target and make sure it is gone: Chrome answered `success` to a close sent while the probe page was still
 * loading and kept the page (measured 2026-11-08), so the close is repeated until Target.getTargets no longer lists
 * it, for at most `timeoutMs`. Never throws: a leftover tab is untidy, not a failed start.
 */
export async function closeTargetSurely(connection, targetId, { timeoutMs = 3_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await connection.send('Target.closeTarget', { targetId }).catch(() => {})
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
    const listed = await connection.send('Target.getTargets', {}).catch(() => undefined)
    const infos = listed?.result?.targetInfos
    if (!Array.isArray(infos) || !infos.some((info) => info.targetId === targetId)) return true
    if (Date.now() > deadline) return false
  }
}

/** `host:port` of a response's remote end; an IPv6 address in brackets (`[::1]:18080`); '' when Chrome gave none. */
export function formatRemote(ip, port) {
  if (!ip) return ''
  return `${ip.includes(':') ? `[${ip}]` : ip}:${port}`
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** `{ host, port }` of `host:port` or `[v6]:port`, the host lower-case and unbracketed; undefined when malformed. */
function hostPort(text) {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(text ?? '').trim())
  return m ? { host: m[1].toLowerCase(), port: Number(m[2]) } : undefined
}

/** Whether two `host:port` texts name the same proxy: the same port, and the same host or both loopback. */
export function sameEndpoint(a, b) {
  const x = hostPort(a)
  const y = hostPort(b)
  if (x === undefined || y === undefined || x.port !== y.port) return false
  return x.host === y.host || (LOOPBACK.has(x.host) && LOOPBACK.has(y.host))
}

/**
 * Whether a probed document came through the expected proxy: undefined when it did, else why not, in words a person
 * can act on. `via` is `host:port`, the proxy the profile's PAC or server names for that URL; hosts compare by
 * address, so `[::1]:18080` and `localhost:18080` are the same local forward.
 */
export function judgeRoute(result, via) {
  if (result?.error) return `the check page did not load (${result.error}): is the proxy ${via} up?`
  if (sameEndpoint(result?.remote, via)) return undefined
  const seen = `${result?.url ?? '?'} answered ${result?.status ?? '?'} from ${result?.remote || 'an unknown address'}` +
    `${result?.server ? ` (server: ${result.server})` : ''}`
  return `the browser went around the proxy: ${seen}, not through ${via}. An enabled extension with the proxy ` +
    'permission, a PAC that fell back to DIRECT or a stale profile setting outranks the start\'s proxy; ' +
    '`cli.mjs --profile=NAME proxy-check` shows which'
}

/**
 * After a proxied start whose profile declares a check (`proxy_check: { url, via }`): load the URL and require that it
 * came through `via`. A start that would go direct fails loudly, its browser stopped, instead of serving pages that
 * answer 403 (#5608). Returns the probe's result, or undefined when there is nothing to check.
 */
export async function verifyProxyRoute(running, options, proxy, { probe = probeRoute, stop = stopChrome } = {}) {
  const url = options.proxyCheckUrl
  const via = options.proxyCheckVia
  if (!url || !via || proxy.length === 0) return undefined
  let result
  try {
    result = await probe(running, url)
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) }
  }
  const why = judgeRoute(result, via)
  if (why !== undefined) {
    await stop(running)
    throw new Error(`${why}; the browser was stopped`)
  }
  return result
}

/**
 * Before `open` on a running proxied browser whose profile declares a check: probe the route again. A browser that
 * has since gone around the proxy is stopped, so the open starts a fresh one whose start verifies the route
 * (measured 2026-11-09: a profile up for ten hours answered 403 from the origin's own address while the PAC and both
 * forwards were fine; clearing Chrome's bad proxies did not help, a restart did). A check page that fails to load
 * (the proxy itself down) only warns: a fresh browser could not do better. Returns `{ restarted, why }` or undefined
 * when the route is right or there is nothing to check.
 */
export async function rerouteIfDirect(options, { statusOf, stop, probe = probeRoute }) {
  const url = options.proxyCheckUrl
  const via = options.proxyCheckVia
  if (!url || !via) return undefined
  const live = await statusOf(options)
  if (!live?.running || !live.health?.wsUrl) return undefined
  let result
  try {
    result = await probe({ wsUrl: live.health.wsUrl }, url)
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) }
  }
  const why = judgeRoute(result, via)
  if (why === undefined) return undefined
  if (result?.error) return { restarted: false, why }
  await stop(options)
  return { restarted: true, why }
}

/** Lists the enabled extensions with the proxy permission and changes nothing (the `proxy-check` command). */
export const PROXY_CONTROLLER_LIST_SCRIPT = `(async () => {
  const left = (await chrome.management.getAll()).filter((e) => e.enabled && (e.permissions || []).includes('proxy'))
    .map((e) => ({ id: e.id, name: e.name, installType: e.installType }))
  return JSON.stringify({ disabled: [], failed: [], left })
})()`

/**
 * The `proxy-check` diagnosis of a running browser: its enabled proxy-controlling extensions (disabled first with
 * `fix`), then the route of `url` when a `via` is named. `{ ok, extensions, disabled, route, problem }`.
 */
export async function proxyCheckReport(running, { url, via, fix = false } = {}, { disable = disableProxyControllers,
  probe = probeRoute } = {}) {
  const report = await disable(running, fix ? {} : { script: PROXY_CONTROLLER_LIST_SCRIPT })
  let route
  let problem
  if (report.left.length > 0) {
    problem = `enabled with the proxy permission: ${report.left.map((e) => `${e.name} (${e.id}, ${e.installType})`).join(', ')}` +
      ' - it outranks the start\'s proxy; `proxy-check --fix` disables it in this profile'
  }
  if (url && via) {
    try {
      route = await probe(running, url)
    } catch (error) {
      route = { error: error instanceof Error ? error.message : String(error) }
    }
    const why = judgeRoute(route, via)
    if (why !== undefined) problem = problem ? `${problem}; ${why}` : why
  }
  return { ok: problem === undefined, extensions: report.left, disabled: report.disabled, route, problem }
}

/** Why a proxied start cannot take effect in `profile`, or undefined: an enabled extension controls the proxy. */
export function proxyRefusal(proxy, profile, extensions = proxyExtensions(profile)) {
  if (proxy.length === 0 || extensions.length === 0) return undefined
  const named = extensions.map((e) => `${e.name} (${e.id})`).join(', ')
  return `the extension ${named} controls the proxy in ${profile}, and Chrome ranks it above ${proxy.join(' ')}, so ` +
    'the start would browse through the extension\'s proxy instead: start from a copy of the profile with ' +
    '--disable-proxy-extensions, or disable the extension in that copy (never in ~/.heddle-browser)'
}

/** Start one browser process and read its endpoint, or throw with the stderr that explains it. */
async function startOnce(executable, options) {
  const profile = options.profile
  mkdirSync(profile, { recursive: true })
  const width = options.width ?? 1280
  const height = options.height ?? 900
  /**
   * A browser given a profile it has seen before may restore the last session, which would put pages
   * the caller never opened in front of the first `list_pages`. The crash bubble is suppressed because
   * a window that says "restore pages?" is a window a person has to click, and this must run unattended.
   */
  const args = [
    ...(options.headless === true ? ['--headless=new'] : ['--new-window']),
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    ...(options.noSandbox === true ? ['--no-sandbox'] : []),
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    ...(options.colorScheme === 'light' ? ['--force-light-mode'] : options.colorScheme === 'dark' ? ['--force-dark-mode'] : []),
    ...(options.proxy ?? []),
    ...(options.args ?? []),
    'about:blank',
  ]
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  try {
    const wsUrl = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the browser printed no debugging endpoint within ${options.timeoutMs ?? 20_000}ms\n${stderr}`)),
        options.timeoutMs ?? 20_000,
      )
      const check = () => {
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
        if (match !== null) {
          clearTimeout(timer)
          resolvePromise(match[1])
        }
      }
      child.stderr.on('data', check)
      check()
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`the browser exited (code ${String(code)}, signal ${String(signal)}) before printing an endpoint\n${stderr}`))
      })
    })
    const port = Number(new URL(wsUrl).port)
    // The endpoint is printed before the browser is ready to answer the HTTP side; `version` is the
    // readiness signal, and it also names the protocol the browser speaks.
    const deadline = Date.now() + 10_000
    let version
    for (;;) {
      try {
        version = await httpJson(port, '/json/version')
        break
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`the browser endpoint at 127.0.0.1:${port} never answered: ${error instanceof Error ? error.message : String(error)}`)
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
    }
    // The sandbox failure is printed while the renderer warms up, which can be a moment after the
    // endpoint line; the window is short because a browser that needs it says so immediately.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, options.sandboxProbeMs ?? 150))
    const running = {
      child,
      wsUrl,
      port,
      profile,
      binary: executable,
      headless: options.headless === true,
      noSandbox: options.noSandbox === true,
      proxy: options.proxy ?? [],
      version,
      stderr: () => stderr,
    }
    if (SANDBOX_FAILURE.test(stderr)) {
      await stopChrome(running)
      throw new Error(`the browser refused its own sandbox and will be retried without it:\n${stderr}`)
    }
    return running
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}

/**
 * Start a browser and return its DevTools endpoint.
 *
 * The debugging port is asked for as `0`, and the endpoint is read from the line Chrome prints — the
 * alternative, picking a free port first and passing it, closes the port between the probe and the
 * start, and that race is the kind a check meets once a week.
 *
 * A machine whose outer confinement forbids Chrome's sandbox gets a **second start** with
 * `--no-sandbox`, and the returned record says which one it was. Silently weakening a browser would be
 * wrong; silently failing on every confined machine would be useless.
 */
export async function launchChrome(options = {}) {
  const executable = options.binary ?? browserPath()
  if (executable === undefined) {
    throw new Error(
      'no browser was found; install Chrome or Chromium, or name one with HEDDLE_BROWSER=/path/to/browser',
    )
  }
  // Judged before anything starts: a bad proxy setting fails here, never as a browser that went direct.
  const proxy = proxyArgs(options)
  const profile = options.profile ?? profileDir()
  const held = profileHeld(profile)
  if (held !== undefined) throw new Error(held)
  const extensions = extensionArgs(options, profile, homedir(), proxy)
  const policy = extensionPolicy(options)
  // keep: an extension that stores a proxy setting refuses the start, as before; the two disabling policies act on
  // the running browser instead (enforceProxyPolicy)
  if (policy === 'keep') {
    const refusal = proxyRefusal(proxy, profile)
    if (refusal !== undefined) throw new Error(refusal)
  }
  const attempts = options.noSandbox === true || process.env.HEDDLE_BROWSER_NO_SANDBOX === '1' ? [true] : [false, true]
  let lastError
  for (const noSandbox of attempts) {
    clearSingleton(profile)
    try {
      const running = await startOnce(executable, { ...options, profile, noSandbox, proxy,
        args: [...extensions, ...(options.args ?? [])] })
      // Verified after the start too: an extension that wrote its proxy setting while Chrome came up still wins.
      const late = policy === 'keep' ? proxyRefusal(proxy, profile) : undefined
      if (late !== undefined) {
        await stopChrome(running)
        throw new Error(late)
      }
      running.proxyControllersDisabled = await enforceProxyPolicy(running, options, proxy,
        options.enforceDeps ?? {})
      running.extensionsDisabled = extensions.length > 0 || running.proxyControllersDisabled.length > 0
      // the route itself, when the profile names a check: flags and extension reports are claims, this is the verdict
      running.proxyRoute = await verifyProxyRoute(running, options, proxy, options.verifyDeps ?? {})
      return running
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const sandboxRefusal = SANDBOX_FAILURE.test(message)
      const singletonRefusal = /ProcessSingleton/.test(message)
      if (!sandboxRefusal && !singletonRefusal) throw error
      // Retry without the sandbox; a stale singleton lock from the refusal is removed by the next start.
    }
  }
  throw lastError
}

/** Remove a profile directory, retrying because Chrome keeps writing into it while it exits. */
export async function removeProfile(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
  }
}

/**
 * Stop a browser, politely when it answers and by signal when it does not.
 *
 * `Browser.close` is what flushes the profile and lets a page's `beforeunload` run, so it is tried
 * first; the signal is the fallback for a browser that is wedged, which is exactly when waiting on
 * politeness would hang.
 */
export async function stopChrome(running) {
  if (running === undefined) return
  try {
    const connection = await connect(running.wsUrl)
    await connection.send('Browser.close', {}, { timeoutMs: 2_000 })
    connection.close()
  } catch {
    // Fall through to the signal.
  }
  const child = running.child
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise))
    child.kill('SIGTERM')
    const timer = new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))
    await Promise.race([exited, timer])
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (running.profile !== undefined && running.temporaryProfile === true) await removeProfile(running.profile)
}

export { httpJson }
