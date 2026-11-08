import { holdsProfile, processAlive, proxyExtensions, singletonHolder } from './chrome.mjs'
import { addExternal, createProfile, listLine, listProfiles, parseCreate, readProfile, refreshProfile,
  removeRegistered, runningText, setProfile, sourceText, startSettings } from './profiles.mjs'

/**
 * What a refresh brought back: a copy of the SSO profile carries Proxy Helper enabled again (the [reflection]
 * Coordinator, 2026-11-02). Under disable-proxy-controllers every start disables it; under keep a proxied start refuses.
 */
export function refreshNote(profile, controllers = proxyExtensions) {
  const found = controllers(profile.userDataDir)
  if (found.length === 0) return ''
  const named = found.map((e) => `${e.name} (${e.id})`).join(', ')
  return profile.extensions === 'disable-proxy-controllers' || profile.extensions === 'disable-all'
    ? `; the copy carries ${named} enabled again - every start disables it (extensions: ${profile.extensions})`
    : `; the copy carries ${named} enabled, which outranks a proxy: a proxied start refuses until ` +
      `\`profile set ${profile.name} extensions=disable-proxy-controllers\``
}

/**
 * Whether a profile's browser runs: this registry's host (its pid), else a live browser outside the registry that
 * holds the profile's data (`{ held: pid }`, e.g. the owner's heddle Chrome on ~/.heddle-browser - Review B on PR
 * 2569, B-M2), else undefined. `refresh` and `remove` treat both as running.
 */
export async function profileRunning(profile, deps = {}) {
  const pid = deps.live === undefined ? undefined : await deps.live(profile.sessionDir)
  if (pid) return pid
  const holder = (deps.holder ?? singletonHolder)(profile.userDataDir)
  if (holder === undefined || holder.foreign) return undefined
  if (!(deps.alive ?? processAlive)(holder.pid)) return undefined
  return (deps.holds ?? holdsProfile)(holder.pid, profile.userDataDir) === 'no' ? undefined : { held: holder.pid }
}

/**
 * The options a command runs with on the selected profile (profiles.mjs, selectProfile): its session folder, its
 * user-data dir and the settings a start applies - the start's own flags first, then HEDDLE_BROWSER_PROXY_* and
 * HEDDLE_BROWSER_HEADLESS, then profile.json - each override of a profile setting reported once through `notify`.
 * Without a selection the flags are returned as they are (today's behaviour); a path selection is today's
 * unregistered `--profile=DIR`.
 */
export function profileOptions(selection, flags = {}, env = process.env, notify = () => {}) {
  if (selection === undefined) return { ...flags }
  if (selection.kind === 'path') {
    notify(`--profile=${selection.path} is an unregistered user-data dir; register it with \`profile add NAME ` +
      `--external=${selection.path}\` (protected) or copy it with \`profile create NAME --from=${selection.path}\``)
    return { ...flags, profile: selection.path }
  }
  const profile = selection.profile
  const settings = startSettings(profile, flags, env)
  for (const line of settings.notices) notify(line)
  return {
    ...flags,
    stateDir: profile.sessionDir,
    profile: profile.userDataDir,
    profileName: profile.name,
    proxyPac: settings.proxyPac,
    proxyServer: settings.proxyServer,
    proxyOrigin: settings.proxyOrigin,
    headless: settings.headless,
    extensionsPolicy: settings.extensions,
    protectedProfile: settings.protectedProfile,
    proxyCheckUrl: settings.proxyCheckUrl,
    proxyCheckVia: settings.proxyCheckVia,
    // the profile's extension policy replaces the start flag, which startSettings has folded into it
    disableProxyExtensions: undefined,
  }
}

/**
 * The page `open` loads: an absolute http(s) URL as given; otherwise a path (or nothing) against the profile's
 * home, its proxy_check URL - so `cli.mjs --profile=ghe open reflection/reflection` needs no host name (#5608).
 */
export function openUrl(target, home) {
  if (typeof target === 'string' && /^https?:\/\//.test(target)) return target
  if (typeof home !== 'string' || home.length === 0) {
    throw new Error('open needs a URL, or a profile with a home (profile set NAME proxy_check.url=URL proxy_check.via=HOST:PORT)')
  }
  return new URL((target ?? '').replace(/^\/+/, ''), home.endsWith('/') ? home : `${home}/`).href
}

/** `profile show`: the stored settings, the resolved paths and whether its browser runs. */
function showText(profile, running) {
  const lines = [
    `profile ${profile.name}${profile.protected ? ' (protected)' : ''}${profile.builtin ? ' (built-in)' : ''}`,
    `  description: ${profile.description || '-'}`,
    `  source: ${sourceText(profile)}`,
    `  user-data dir: ${profile.userDataDir}`,
    `  session folder: ${profile.sessionDir}`,
    `  proxy: ${profile.proxy?.pac ? `pac ${profile.proxy.pac}` : profile.proxy?.server ? `server ${profile.proxy.server}` : 'none'}`,
    `  extensions: ${profile.extensions ?? 'keep'}`,
    `  headless by default: ${profile.headless === true}`,
    `  created: ${profile.created ?? '-'}`,
    `  running: ${runningText(running)}`,
  ]
  return lines.join('\n')
}

/**
 * `cli.mjs profile list | show NAME | create NAME [...] | add NAME --external=PATH | set NAME key=value... |
 * refresh NAME | remove NAME`. `deps.running(profile)` answers the pid of the profile's running browser, or nothing.
 * Returns the text to print.
 */
export async function profileCommand(args, deps = {}, ctx = {}) {
  const running = deps.running ?? (async () => undefined)
  const [verb, ...rest] = args
  if (verb === undefined || verb === 'list') {
    const lines = []
    for (const p of listProfiles(ctx)) lines.push(listLine(p, await running(p)))
    return lines.join('\n')
  }
  if (verb === 'show') {
    const profile = readProfile(need(rest[0], 'show'), ctx)
    return showText(profile, await running(profile))
  }
  if (verb === 'create') {
    const { name, options } = parseCreate(rest)
    if (options.external !== undefined) throw new Error('--external belongs to `profile add NAME --external=PATH`')
    const profile = createProfile(name, options, ctx)
    return `created ${profile.name}: source ${sourceText(profile)}\n${showText(profile)}`
  }
  if (verb === 'add') {
    const { name, options } = parseCreate(rest)
    if (options.external === undefined) throw new Error('profile add needs --external=PATH')
    const profile = addExternal(name, options.external, { description: options.description }, ctx)
    return `added ${profile.name}: protected reference to ${profile.userDataDir}`
  }
  if (verb === 'set') {
    const [name, ...pairs] = rest
    if (pairs.length === 0) throw new Error('profile set needs NAME key=value ...')
    return showText(setProfile(need(name, 'set'), pairs, ctx))
  }
  if (verb === 'refresh') {
    const profile = readProfile(need(rest[0], 'refresh'), ctx)
    const refreshed = refreshProfile(profile.name, { running: Boolean(await running(profile)) }, ctx)
    return `refreshed ${refreshed.name} from ${refreshed.source.from}` + refreshNote(refreshed)
  }
  if (verb === 'remove') {
    const profile = readProfile(need(rest[0], 'remove'), ctx)
    const result = removeRegistered(profile.name, { running: Boolean(await running(profile)) }, ctx)
    return result.kept ? `removed the reference ${result.removed}; ${result.kept} is untouched` : `removed ${result.removed}`
  }
  throw new Error(`unknown profile command '${verb}' (list, show, create, add, set, refresh, remove)`)
}

function need(name, verb) {
  if (name === undefined || name.startsWith('--')) throw new Error(`profile ${verb} needs a NAME`)
  return name
}
