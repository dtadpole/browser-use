import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { proxyArgs } from './chrome.mjs'

/**
 * Profiles: browser-use's first-class notion of **who the browser is and how it reaches the network** (owner request
 * 2026-10-30 06:4x PDT, the [reflection] Coordinator's item 20261030T133505Z).
 *
 * A profile is a folder `<root>/profiles/<name>/` holding `profile.json` (its settings), `chrome-profile/` (the
 * Chrome user-data dir: logins, cookies, extensions) and `session/` (the socket, state and log of its one running
 * browser). `default` and `sso` exist without a folder: `default` is today's layout (`<root>/chrome-profile`, its
 * session files in `<root>`), and `sso` is a protected reference to the SSO-authenticated `~/.heddle-browser`.
 * The root is HEDDLE_BROWSER_HOME, else `~/.browser-use/browser`.
 */

export const NAME = /^[a-z][a-z0-9-]{0,39}$/
export const EXTENSION_POLICIES = ['keep', 'disable-proxy-controllers', 'disable-all']
export const RESERVED = ['default', 'sso']
const SETTABLE = ['description', 'proxy.pac', 'proxy.server', 'proxy_check.url', 'proxy_check.via', 'extensions',
  'headless', 'source']

/** The state root: HEDDLE_BROWSER_HOME, else ~/.browser-use/browser (sessions and profiles live under it). */
export function stateRoot(env = process.env, home = homedir()) {
  const fromEnvironment = env.HEDDLE_BROWSER_HOME
  return fromEnvironment !== undefined && fromEnvironment.length > 0 ? fromEnvironment : join(home, '.browser-use', 'browser')
}

/** A `--profile=` value is a path when it holds a '/' or starts with '~' or '.'; otherwise it names a profile. */
export function isPathValue(value) {
  return value.includes('/') || value.startsWith('~') || value.startsWith('.')
}

export function expandHome(path, home = homedir()) {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/**
 * The registry's root: the state root, unless that lies inside the SSO profile's home (the established
 * `HEDDLE_BROWSER_HOME=$HOME/.heddle-browser`), where the registry would write copies and session files into the
 * protected folder (Review A on PR 2569, A-M1); then it is ~/.browser-use/browser. The `default` profile still
 * follows HEDDLE_BROWSER_HOME.
 */
export function registryRoot(root, env = process.env, home = homedir()) {
  // both resolved through links: an alias of the SSO home is the SSO home (Review A on PR 2581, A-M1)
  // a path that does not exist yet resolves through its nearest existing parent
  const real = (path) => {
    let at = resolve(path)
    const tail = []
    for (;;) {
      try {
        return join(realpathSync(at), ...tail)
      } catch {
        const parent = dirname(at)
        if (parent === at) return resolve(path)
        tail.unshift(basename(at))
        at = parent
      }
    }
  }
  const protectedHome = real(join(ssoPath(env, home), '..'))
  const target = real(root)
  if (target === protectedHome || target.startsWith(protectedHome + sep)) return join(home, '.browser-use', 'browser')
  return root
}

function context(ctx = {}) {
  const home = ctx.home ?? homedir()
  const env = ctx.env ?? process.env
  const root = ctx.root ?? stateRoot(env, home)
  return { home, root, registry: registryRoot(root, env, home), now: ctx.now ?? (() => new Date()) }
}

/** The SSO profile's user-data dir: HEDDLE_BROWSER_SSO_PROFILE, else ~/.heddle-browser/chrome-profile. */
export function ssoPath(env = process.env, home = homedir()) {
  const fromEnvironment = env.HEDDLE_BROWSER_SSO_PROFILE
  return fromEnvironment !== undefined && fromEnvironment.length > 0 ? fromEnvironment : join(home, '.heddle-browser', 'chrome-profile')
}

function blank(name) {
  return {
    version: 1,
    name,
    description: '',
    created: null,
    source: { kind: 'fresh', from: null, copied_at: null },
    user_data_dir: null,
    proxy: { pac: null, server: null },
    extensions: 'keep',
    headless: false,
    protected: false,
  }
}

/** The built-in profiles, as they read when no profile.json overrides them. */
function builtin(name, c, env) {
  if (name === 'default') {
    return { ...blank('default'), description: 'the browser-use default profile', dir: c.root,
      userDataDir: join(c.root, 'chrome-profile'), sessionDir: c.root, builtin: true }
  }
  if (name === 'sso') {
    const path = ssoPath(env, c.home)
    return { ...blank('sso'), description: 'the SSO-authenticated profile (external, never changed by browser-use)',
      source: { kind: 'external', from: path, copied_at: null }, user_data_dir: path, protected: true,
      dir: join(c.registry, 'profiles', 'sso'), userDataDir: path, sessionDir: join(c.registry, 'profiles', 'sso', 'session'),
      builtin: true }
  }
  return undefined
}

function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`'${name}' is not a profile name (a lowercase letter, then up to 39 letters, digits or '-')`)
  }
}

/** A profile with its paths resolved: `dir`, `userDataDir`, `sessionDir`. Throws for an unknown name. */
export function readProfile(name, ctx = {}) {
  checkName(name)
  const c = context(ctx)
  const env = ctx.env ?? process.env
  const dir = join(c.registry, 'profiles', name)
  const file = join(dir, 'profile.json')
  if (!existsSync(file)) {
    const fixed = builtin(name, c, env)
    if (fixed !== undefined) return fixed
    const known = listProfiles(ctx).map((p) => p.name).join(', ')
    throw new Error(`there is no profile '${name}' (profiles: ${known}); create it with \`cli.mjs profile create ${name}\``)
  }
  const data = { ...blank(name), ...JSON.parse(readFileSync(file, 'utf8')) }
  const external = data.source?.kind === 'external'
  return {
    ...data,
    name,
    protected: data.protected === true || external,
    dir,
    userDataDir: external ? data.user_data_dir : join(dir, 'chrome-profile'),
    sessionDir: join(dir, 'session'),
    builtin: false,
  }
}

/** Every profile: default and sso first, then the registered ones by name. */
export function listProfiles(ctx = {}) {
  const c = context(ctx)
  const env = ctx.env ?? process.env
  const names = []
  try {
    for (const entry of readdirSync(join(c.registry, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory() && NAME.test(entry.name) && existsSync(join(c.registry, 'profiles', entry.name, 'profile.json'))) {
        names.push(entry.name)
      }
    }
  } catch {
    // no registry yet
  }
  const out = RESERVED.filter((n) => !names.includes(n)).map((n) => builtin(n, c, env))
  for (const n of [...names].sort()) out.push(readProfile(n, ctx))
  return out.sort((a, b) => (RESERVED.indexOf(a.name) + 1 || 99) - (RESERVED.indexOf(b.name) + 1 || 99) || a.name.localeCompare(b.name))
}

/** What a copy leaves behind: the running browser's lock and socket, and caches Chrome rebuilds. */
const SKIP = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Cache', 'Code Cache', 'GPUCache',
  'ShaderCache', 'GrShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'CacheStorage', 'Crashpad',
  'component_crx_cache', 'BrowserMetrics'])

export function skipped(path, src) {
  return relative(src, path).split(sep).some((part) => SKIP.has(part) || part.startsWith('Singleton'))
}

/** Copy a user-data dir into `dst` (a new folder), leaving out locks and caches. A live source may be copied. */
export function copyUserData(src, dst) {
  if (!existsSync(src)) throw new Error(`the source profile ${src} does not exist`)
  mkdirSync(dst, { recursive: true })
  cpSync(src, dst, { recursive: true, filter: (path) => !skipped(path, src), verbatimSymlinks: true })
}

function writeProfile(dir, data) {
  mkdirSync(dir, { recursive: true })
  const { dir: _d, userDataDir: _u, sessionDir: _s, builtin: _b, ...stored } = data
  const tmp = join(dir, 'profile.json.tmp')
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`)
  renameSync(tmp, join(dir, 'profile.json'))
}

function checkSettings(settings) {
  if (settings.extensions !== undefined && !EXTENSION_POLICIES.includes(settings.extensions)) {
    throw new Error(`extensions must be one of ${EXTENSION_POLICIES.join(', ')}, not '${settings.extensions}'`)
  }
  // a bad proxy fails here, as it does at a start
  proxyArgs({ proxyPac: settings.proxy?.pac ?? undefined, proxyServer: settings.proxy?.server ?? undefined }, {})
  checkProxyCheck(settings.proxy_check)
}

/**
 * A profile's route check (#5608): `{ url, via }` - a page to load at each proxied start and the proxy `host:port` it
 * must come through. Both or neither; the URL is http or https.
 */
export function checkProxyCheck(check) {
  const url = check?.url ?? null
  const via = check?.via ?? null
  if (url === null && via === null) return
  if (url === null || via === null) throw new Error('proxy_check needs both a url and a via (host:port), or neither')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`proxy_check.url '${url}' is not a URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('proxy_check.url must be http or https')
  if (!/^(\[[0-9a-fA-F:.]+\]|[^\s:/[\]]+):\d{1,5}$/.test(via)) throw new Error(`proxy_check.via '${via}' is not host:port`)
}

/**
 * Create a profile: fresh (an empty user-data dir), `from` a user-data dir path, or a `clone` of another profile.
 * `settings`: description, proxy {pac, server}, extensions, headless. Returns the profile.
 */
export function createProfile(name, { from, clone, ...settings } = {}, ctx = {}) {
  checkName(name)
  if (RESERVED.includes(name)) throw new Error(`'${name}' is a built-in profile and cannot be created`)
  const c = context(ctx)
  const dir = join(c.registry, 'profiles', name)
  if (existsSync(join(dir, 'profile.json'))) throw new Error(`the profile '${name}' already exists`)
  if (from !== undefined && clone !== undefined) throw new Error('give --from=PATH or --clone=NAME, not both')
  const data = { ...blank(name), ...settings, proxy: { ...blank(name).proxy, ...(settings.proxy ?? {}) },
    created: c.now().toISOString() }
  checkSettings(data)
  let source = null
  if (from !== undefined) source = resolve(expandHome(from, c.home))
  else if (clone !== undefined) source = readProfile(clone, ctx).userDataDir
  if (source !== null) {
    copyUserData(source, join(dir, 'chrome-profile'))
    data.source = { kind: 'copy', from: clone ?? source, copied_at: c.now().toISOString() }
  } else {
    mkdirSync(join(dir, 'chrome-profile'), { recursive: true })
  }
  writeProfile(dir, data)
  return readProfile(name, ctx)
}

/** Register an existing user-data dir by reference: always protected, never copied, written or removed. */
export function addExternal(name, path, { description = '' } = {}, ctx = {}) {
  checkName(name)
  if (RESERVED.includes(name)) throw new Error(`'${name}' is a built-in profile and cannot be added`)
  const c = context(ctx)
  const dir = join(c.registry, 'profiles', name)
  if (existsSync(join(dir, 'profile.json'))) throw new Error(`the profile '${name}' already exists`)
  const target = resolve(expandHome(path, c.home))
  if (!existsSync(target)) throw new Error(`${target} does not exist`)
  writeProfile(dir, { ...blank(name), description, created: c.now().toISOString(),
    source: { kind: 'external', from: target, copied_at: null }, user_data_dir: target, protected: true })
  return readProfile(name, ctx)
}

/** Parse one `key=value` of `profile set`. */
export function parseSetting(pair) {
  const index = pair.indexOf('=')
  if (index < 1) throw new Error(`'${pair}' is not key=value`)
  const key = pair.slice(0, index)
  const raw = pair.slice(index + 1)
  if (!SETTABLE.includes(key)) throw new Error(`'${key}' cannot be set (settable: ${SETTABLE.join(', ')})`)
  if (key === 'headless') {
    if (raw !== 'true' && raw !== 'false') throw new Error('headless is true or false')
    return { key, value: raw === 'true' }
  }
  return { key, value: raw === '' || raw === 'none' ? null : raw }
}

/** Change settings of a registered profile; a protected one may change only its description. */
export function setProfile(name, pairs, ctx = {}) {
  const profile = readProfile(name, ctx)
  const changes = pairs.map(parseSetting)
  if (profile.builtin) throw new Error(`'${name}' is a built-in profile; its settings cannot be changed`)
  if (profile.protected && changes.some((ch) => ch.key !== 'description')) {
    throw new Error(`'${name}' is protected: only its description can be changed`)
  }
  const data = { ...profile, proxy: { ...profile.proxy }, source: { ...profile.source } }
  for (const { key, value } of changes) {
    if (key === 'proxy.pac') data.proxy.pac = value
    else if (key === 'proxy.server') data.proxy.server = value
    else if (key === 'proxy_check.url') data.proxy_check = { ...(data.proxy_check ?? {}), url: value }
    else if (key === 'proxy_check.via') data.proxy_check = { ...(data.proxy_check ?? {}), via: value }
    else if (key === 'source') {
      // re-point where `refresh` copies from: another profile's name or a user-data dir path
      if (value === null) throw new Error('source needs a profile name or a path')
      const c = context(ctx)
      const from = isPathValue(value) ? resolve(expandHome(value, c.home)) : value
      if (!isPathValue(value)) readProfile(value, ctx)
      else if (!existsSync(from)) throw new Error(`${from} does not exist`)
      data.source = { kind: 'copy', from, copied_at: profile.source?.copied_at ?? null }
    } else data[key] = value ?? (key === 'description' ? '' : value)
  }
  checkSettings(data)
  writeProfile(profile.dir, data)
  return readProfile(name, ctx)
}

/** Re-copy a stopped copy-profile from its recorded source, keeping its settings. */
export function refreshProfile(name, { running = false } = {}, ctx = {}) {
  const profile = readProfile(name, ctx)
  if (profile.protected) throw new Error(`'${name}' is protected: browser-use never refreshes into it`)
  if (profile.source?.kind !== 'copy') throw new Error(`'${name}' was not copied from anything; nothing to refresh from`)
  if (running) throw new Error(`'${name}' is running; stop it (cli.mjs --profile=${name} stop) before a refresh`)
  const c = context(ctx)
  const from = profile.source.from
  const source = isAbsolute(from) ? from : readProfile(from, ctx).userDataDir
  const fresh = join(profile.dir, 'chrome-profile.new')
  const old = join(profile.dir, 'chrome-profile.old')
  rmSync(fresh, { recursive: true, force: true })
  copyUserData(source, fresh)
  rmSync(old, { recursive: true, force: true })
  if (existsSync(profile.userDataDir)) renameSync(profile.userDataDir, old)
  renameSync(fresh, profile.userDataDir)
  rmSync(old, { recursive: true, force: true })
  writeProfile(profile.dir, { ...profile, source: { ...profile.source, copied_at: c.now().toISOString() } })
  return readProfile(name, ctx)
}

/** Remove a registered profile and its copy; refused for built-in, protected and running ones. */
export function removeRegistered(name, { running = false } = {}, ctx = {}) {
  const profile = readProfile(name, ctx)
  if (profile.builtin) throw new Error(`'${name}' is a built-in profile and cannot be removed`)
  if (running) throw new Error(`'${name}' is running; stop it (cli.mjs --profile=${name} stop) first`)
  if (profile.protected) {
    // a protected reference: forget the reference only; its user-data dir is never touched
    rmSync(join(profile.dir, 'profile.json'), { force: true })
    rmSync(profile.sessionDir, { recursive: true, force: true })
    return { removed: name, kept: profile.userDataDir }
  }
  if (basename(profile.dir) !== name || !profile.dir.startsWith(join(context(ctx).registry, 'profiles') + sep)) {
    throw new Error(`refusing to remove ${profile.dir}: not a profile folder`)
  }
  rmSync(profile.dir, { recursive: true, force: true })
  return { removed: name }
}

/**
 * The settings a start on `profile` uses, and why. Precedence: the start's flags, then HEDDLE_BROWSER_PROXY_* and
 * HEDDLE_BROWSER_HEADLESS, then profile.json; an override of a profile setting gives a one-line notice.
 * The proxy is one setting: whichever level names a PAC or a server supplies both.
 */
export function startSettings(profile, flags = {}, env = process.env) {
  const notices = []
  const fromFlags = { pac: flags.proxyPac, server: flags.proxyServer }
  const fromEnv = { pac: env.HEDDLE_BROWSER_PROXY_PAC || undefined, server: env.HEDDLE_BROWSER_PROXY_SERVER || undefined }
  const fromProfile = { pac: profile.proxy?.pac ?? undefined, server: profile.proxy?.server ?? undefined }
  const any = (p) => p.pac !== undefined || p.server !== undefined
  let proxy = { pac: undefined, server: undefined }
  let origin = 'none'
  if (any(fromFlags)) [proxy, origin] = [fromFlags, 'flag']
  else if (any(fromEnv)) [proxy, origin] = [fromEnv, 'env']
  else if (any(fromProfile)) [proxy, origin] = [fromProfile, 'profile']
  if (origin !== 'profile' && origin !== 'none' && any(fromProfile)) {
    const shown = (p) => p.pac ?? p.server
    notices.push(`profile ${profile.name}: its proxy ${shown(fromProfile)} is overridden by the ${origin === 'flag' ? 'start flag' : 'environment'} (${shown(proxy)})`)
  }
  let headless = profile.headless === true
  if (flags.headless === true) headless = true
  else if (env.HEDDLE_BROWSER_HEADLESS === '1') headless = true
  let extensions = profile.extensions ?? 'keep'
  // the start flag keeps its #2133 meaning: --disable-extensions on this start
  if (flags.disableProxyExtensions === true) extensions = 'disable-all'
  // the profile's route check describes the profile's own proxy; another proxy from a flag or the environment skips it
  const check = profile.proxy_check ?? {}
  let proxyCheckUrl
  let proxyCheckVia
  if (check.url && check.via) {
    if (origin === 'profile') [proxyCheckUrl, proxyCheckVia] = [check.url, check.via]
    else if (origin !== 'none') notices.push(`profile ${profile.name}: its route check (${check.url} via ${check.via}) is skipped for the overriding proxy`)
  }
  return { proxyPac: proxy.pac, proxyServer: proxy.server, proxyOrigin: origin, headless, extensions,
    protectedProfile: profile.protected === true, proxyCheckUrl, proxyCheckVia, notices }
}

/** Where a profile's login comes from, in one phrase: what a person picks a profile for. */
export function sourceText(profile) {
  const src = profile.source ?? {}
  if (src.kind === 'external') return `external ${src.from}`
  if (src.kind === 'copy') return `copy of ${src.from}${src.copied_at ? ` (copied ${src.copied_at.slice(0, 16)}Z)` : ''}`
  return 'fresh'
}

/** A profile's browser in words: this registry's host (`pid N`), another browser holding its data, or no. */
export function runningText(running) {
  if (running === undefined || running === null || running === false) return 'no'
  if (typeof running === 'object') return `held by pid ${running.held} (a browser outside this registry)`
  return `pid ${running}`
}

/** One line of `profile list`. */
export function listLine(profile, running) {
  const proxy = profile.proxy?.pac ?? profile.proxy?.server ?? 'none'
  const checked = profile.proxy_check?.via ? ` (checked via ${profile.proxy_check.via})` : ''
  return `${profile.name.padEnd(12)} ${profile.protected ? 'protected ' : '          '}source: ${sourceText(profile)}; ` +
    `proxy: ${proxy}${checked}; extensions: ${profile.extensions ?? 'keep'}; running: ${runningText(running)}`
}

/**
 * The global `--profile=` of a command line: `{ argv, selection }` with the option removed. A path value (a '/',
 * a leading '~' or '.') is today's unregistered user-data dir; any other value names a registered profile, which
 * must exist. `--session=NAME` with a profile name is refused: a profile has one browser.
 */
export function selectProfile(argv, ctx = {}) {
  const found = argv.filter((arg) => arg.startsWith('--profile='))
  if (found.length === 0) return { argv, selection: undefined }
  if (found.length > 1) throw new Error('--profile is given more than once')
  const value = found[0].slice('--profile='.length)
  if (value.length === 0) throw new Error('--profile needs a profile name or a path')
  const rest = argv.filter((arg) => arg !== found[0])
  if (isPathValue(value)) return { argv: rest, selection: { kind: 'path', path: resolve(expandHome(value, context(ctx).home)) } }
  if (argv.some((arg) => arg.startsWith('--session=')) || (ctx.env ?? process.env).HEDDLE_BROWSER_SESSION) {
    throw new Error(`--session and --profile=${value} do not combine: a profile has one browser; use --profile=${value} alone`)
  }
  return { argv: rest, selection: { kind: 'name', profile: readProfile(value, ctx) } }
}

/** Parse the arguments of `profile create|add`: `{ name, options }`. */
export function parseCreate(args) {
  const [name, ...flags] = args
  if (name === undefined || name.startsWith('--')) throw new Error('profile create needs a NAME')
  const options = {}
  for (const flag of flags) {
    if (flag.startsWith('--from=')) options.from = flag.slice('--from='.length)
    else if (flag.startsWith('--clone=')) options.clone = flag.slice('--clone='.length)
    else if (flag.startsWith('--external=')) options.external = flag.slice('--external='.length)
    else if (flag.startsWith('--proxy-pac=')) options.proxy = { ...(options.proxy ?? {}), pac: flag.slice('--proxy-pac='.length) }
    else if (flag.startsWith('--proxy-server=')) options.proxy = { ...(options.proxy ?? {}), server: flag.slice('--proxy-server='.length) }
    else if (flag.startsWith('--extensions=')) options.extensions = flag.slice('--extensions='.length)
    else if (flag.startsWith('--proxy-check-url=')) options.proxy_check = { ...(options.proxy_check ?? {}), url: flag.slice('--proxy-check-url='.length) }
    else if (flag.startsWith('--proxy-check-via=')) options.proxy_check = { ...(options.proxy_check ?? {}), via: flag.slice('--proxy-check-via='.length) }
    else if (flag === '--disable-proxy-extensions') options.extensions = 'disable-proxy-controllers'
    else if (flag === '--headless') options.headless = true
    else if (flag.startsWith('--description=')) options.description = flag.slice('--description='.length)
    else throw new Error(`unknown profile option '${flag}'`)
  }
  return { name, options }
}
