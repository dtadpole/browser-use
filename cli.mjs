#!/usr/bin/env node
import { readFileSync } from 'node:fs'

import { browserPath, defaultProfilePath, proxyArgs, proxyCheckReport, rerouteIfDirect, stateDir } from './chrome.mjs'
import { callTool, liveHost, proxyMismatch, startHostProcess, status, stopHost } from './client.mjs'
import { openUrl, profileCommand, profileOptions, profileRunning } from './profile-cli.mjs'
import { selectProfile } from './profiles.mjs'
import { startHost } from './host.mjs'
import { TOOL_HELP, TOOL_NAMES } from './tools.mjs'

/**
 * The command line for the browser tool.
 *
 * One command per browser tool, with the tool's arguments as either one JSON object or `--name=value`
 * pairs, so a shell that is bad at quoting is not the reason a call fails:
 *
 *     node cli.mjs take_snapshot
 *     node cli.mjs click '{"uid": "1_3"}'
 *     node cli.mjs fill --uid=1_4 --value=hello
 *
 * `start`, `stop` and `status` manage the session host. Any tool call starts one if none is running.
 */

const USAGE = `browser — drive a real Chrome over the DevTools protocol

profiles - who the browser is (logins, cookies, extensions) and how it reaches the network (proxy):
  every command runs on a profile, 'default' when none is named; --profile=NAME selects one for start, stop,
  status and every tool, and its settings apply at start with no environment variables.
  node cli.mjs profile list | show NAME | refresh NAME | remove NAME
  node cli.mjs profile create NAME [--from=PATH | --clone=NAME] [--proxy-pac=URL | --proxy-server=S]
               [--extensions=keep|disable-proxy-controllers|disable-all] [--headless] [--description=T]
               [--proxy-check-url=URL --proxy-check-via=HOST:PORT]
  node cli.mjs profile add NAME --external=PATH        (a protected reference, like 'sso')
  node cli.mjs profile set NAME key=value ...          (proxy.pac proxy.server proxy_check.url proxy_check.via
                                                         extensions headless source description)
  A profile's proxy_check (--proxy-check-url=URL --proxy-check-via=HOST:PORT) is verified at every proxied start: the URL
  must come back through that proxy, or the start fails and stops the browser (an extension or a DIRECT fallback won).
  A --profile value with '/', or starting with '~' or '.', is a user-data dir path (the older form).

usage:
  node cli.mjs <tool> [json | --name=value ...] [--profile=NAME] [--session=NAME]
  node cli.mjs start [--headless] [--session=NAME] [--profile=DIR] [--binary=PATH] [--state=DIR]
                     [--proxy-pac=URL | --proxy-server=HOST:PORT] [--disable-proxy-extensions]
  node cli.mjs stop [--session=NAME]
  node cli.mjs status [--session=NAME]
  node cli.mjs tools
  node cli.mjs --profile=NAME open [PATH | URL]
  node cli.mjs --profile=NAME proxy-check [--url=URL --via=HOST:PORT] [--fix]

a site reached only through a proxy, in one line (a profile with that PAC and a route check; proxied-site.md):
  node cli.mjs --profile=site open some/path

commands:
  start    open the browser and keep it open for later commands (a visible window)
  stop     close the browser and forget the session
  status   report whether a browser is running, and on which endpoint
  tools    list the tools this implementation offers
  open     a new page at a URL, or at a path under the profile's home (its proxy_check URL); starts the browser,
           and restarts one whose route check now goes around the proxy
  proxy-check  the running browser's proxy-controlling extensions and the real route of the check URL; exit 1 on a
           problem; --fix disables those extensions in this profile

state and isolation:
  the browser profile and the session live in ${stateDir()} (HEDDLE_BROWSER_HOME moves them);
  a login done in the visible window is reused by every later call in that session.

  --session=NAME (or HEDDLE_BROWSER_SESSION) gives this command a browser of its own: its own
  process, profile and tabs, under state/sessions/NAME/. Two sessions never see each other's
  pages, so two agents driving a browser at once do not fight over one selected page.

proxy (the browser's own, never the system's):
  --proxy-pac=URL (or HEDDLE_BROWSER_PROXY_PAC) passes --proxy-pac-url; an http: or https: URL only.
  --proxy-server=HOST:PORT (or HEDDLE_BROWSER_PROXY_SERVER) passes --proxy-server. With both, the PAC wins.
  A proxied start fails when an enabled extension controls the proxy in the profile (it would outrank the flag);
  --disable-proxy-extensions starts with --disable-extensions, on a copy of a profile only (never ~/.heddle-browser).
  A start fails when another running browser holds the profile (it would take this start's flags and drop them).
  It applies when a browser starts: use a --session of its own, e.g. for a site behind a proxy
    HEDDLE_BROWSER_PROXY_PAC=http://127.0.0.1:18085/site.pac cli.mjs --session=site new_page '{"url": "https://git.example.com/"}'

examples:
  cli.mjs new_page '{"url": "https://example.com"}'
  cli.mjs take_snapshot
  cli.mjs click '{"uid": "1_2"}'
  cli.mjs take_screenshot '{"fullPage": true}'
`

/** Parse `--name=value` pairs into an argument object, converting booleans and numbers. */
function parsePairs(pairs) {
  const args = {}
  for (const pair of pairs) {
    if (!pair.startsWith('--')) throw new Error(`'${pair}' is not a --name=value argument`)
    const body = pair.slice(2)
    const index = body.indexOf('=')
    if (index < 0) {
      args[body] = true
      continue
    }
    const name = body.slice(0, index)
    const raw = body.slice(index + 1)
    if (raw === 'true' || raw === 'false') args[name] = raw === 'true'
    else if (raw !== '' && Number.isFinite(Number(raw)) && !/^0\d/.test(raw) && name !== 'uid') args[name] = Number(raw)
    else if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        args[name] = JSON.parse(raw)
      } catch {
        args[name] = raw
      }
    } else args[name] = raw
    /** The schema names a coordinate pair `x`/`y`; a caller typing `--x=1` means the number. */
    if (name === 'uid') args[name] = String(raw)
  }
  return args
}

/** Everything after the command, as one argument object. */
function parseToolArguments(rest) {
  if (rest.length === 0) return {}
  if (rest[0].startsWith('{')) {
    try {
      const parsed = JSON.parse(rest[0])
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      return parsed
    } catch (error) {
      throw new Error(`the argument object is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (rest[0].startsWith('--file=')) {
    const path = rest[0].slice('--file='.length)
    if (path.length === 0) throw new Error('--file needs a path')
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  if (rest[0] === '--file') {
    const path = rest[1]
    if (path === undefined) throw new Error('--file needs a path')
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  return parsePairs(rest)
}

/** Print one result: its text when it has one, JSON otherwise. */
function printResult(result, { json = false } = {}) {
  if (json !== true && typeof result?.text === 'string') {
    console.log(result.text)
    return
  }
  console.log(JSON.stringify(result, null, 2))
}

/** The internal command `cli.mjs __daemon` runs the session host in the foreground of its own process. */
async function daemon(argv) {
  const options = {}
  for (const arg of argv) {
    if (arg === '--headless') options.headless = true
    else if (arg.startsWith('--state=')) options.stateDir = arg.slice('--state='.length)
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg.startsWith('--binary=')) options.binary = arg.slice('--binary='.length)
    else if (arg.startsWith('--width=')) options.width = Number(arg.slice('--width='.length))
    else if (arg.startsWith('--height=')) options.height = Number(arg.slice('--height='.length))
    else if (arg.startsWith('--proxy-pac=')) options.proxyPac = arg.slice('--proxy-pac='.length)
    else if (arg.startsWith('--proxy-server=')) options.proxyServer = arg.slice('--proxy-server='.length)
    else if (arg === '--disable-proxy-extensions') options.disableProxyExtensions = true
    else if (arg.startsWith('--extensions=')) options.extensionsPolicy = arg.slice('--extensions='.length)
    else if (arg === '--protected') options.protectedProfile = true
    else if (arg.startsWith('--proxy-check-url=')) options.proxyCheckUrl = arg.slice('--proxy-check-url='.length)
    else if (arg.startsWith('--proxy-check-via=')) options.proxyCheckVia = arg.slice('--proxy-check-via='.length)
    else if (arg.startsWith('--profile-name=')) options.profileName = arg.slice('--profile-name='.length)
  }
  const host = await startHost(options)
  const stop = async () => {
    await host.shutdown()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  // Keep the process alive on the server itself; the browser may outlive a quiet moment.
  await new Promise(() => {})
}

async function main(argv) {
  /**
   * The profile is a property of the invocation, like the session: `--profile=NAME` selects a registered profile
   * (its user-data dir, its session folder and its settings) for start, stop, status and every tool; a path value is
   * today's unregistered user-data dir (profiles.mjs, selectProfile).
   */
  let selection
  if (argv[0] !== '__daemon') ({ argv, selection } = selectProfile(argv))
  /**
   * The session name is a property of the invocation rather than of one command, so it is read before
   * the command is dispatched and removed from the arguments an individual tool would otherwise see.
   */
  const sessionArgument = argv.find((arg) => arg.startsWith('--session='))
  if (sessionArgument !== undefined) {
    const name = sessionArgument.slice('--session='.length)
    if (name.length === 0) throw new Error('--session needs a name')
    process.env.HEDDLE_BROWSER_SESSION = name
    argv = argv.filter((arg) => !arg.startsWith('--session='))
  }
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command === '__daemon') {
    await daemon(rest)
    return 0
  }
  if (command === 'profile') {
    const live = async (dir) => (await liveHost(dir))?.health?.pid
    const out = await profileCommand(rest, { running: (p) => profileRunning(p, { live }) })
    process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
    return 0
  }
  // the selected profile's paths and settings; flags given to start still win (profile-cli.mjs, profileOptions)
  const notify = (line) => process.stderr.write(`browser-use: ${line}\n`)
  if (command === 'tools') {
    const lines = ['the tools this browser implementation offers:']
    for (const name of TOOL_NAMES) lines.push(`  ${name.padEnd(24)} ${TOOL_HELP[name] ?? ''}`)
    lines.push('', 'arguments are one JSON object, or --name=value pairs', '')
    lines.push('not replicated from the harness browser: lighthouse_audit (the Lighthouse engine) and')
    lines.push('performance_analyze_insight (the DevTools frontend insight model). The trace itself is')
    lines.push('recorded by performance_start_trace and performance_stop_trace, and the other advertised')
    lines.push('tool groups the DSH row leaves off (vision, memory analysis, DevTools comments) are not')
    lines.push('part of the 32 tools this tool measures itself against.')
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  }

  const options = {}
  if (command === 'start') {
    let state
    for (const arg of rest) {
      if (arg === '--headless') options.headless = true
      else if (arg === '--json') options.json = true
      else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
      else if (arg.startsWith('--binary=')) options.binary = arg.slice('--binary='.length)
      else if (arg.startsWith('--state=')) state = arg.slice('--state='.length)
      else if (arg.startsWith('--width=')) options.width = Number(arg.slice('--width='.length))
      else if (arg.startsWith('--height=')) options.height = Number(arg.slice('--height='.length))
      else if (arg.startsWith('--proxy-pac=')) options.proxyPac = arg.slice('--proxy-pac='.length)
      else if (arg.startsWith('--proxy-server=')) options.proxyServer = arg.slice('--proxy-server='.length)
      else if (arg === '--disable-proxy-extensions') options.disableProxyExtensions = true
      else throw new Error(`unknown start option '${arg}'`)
    }
    Object.assign(options, profileOptions(selection, options, process.env, notify))
    const requested = proxyArgs(options) // a bad proxy setting fails here, before a host process is started
    const live = await status({ ...options, ...(state !== undefined ? { stateDir: state } : {}) })
    if (live.running) {
      const mismatch = proxyMismatch(requested, live.health, state ?? options.stateDir ?? stateDir())
      if (mismatch !== undefined) throw new Error(mismatch)
      printResult({ running: true, pid: live.health?.pid, endpoint: live.health?.wsUrl, headless: live.health?.headless })
      return 0
    }
    const started = await startHostProcess({ ...options, ...(state !== undefined ? { stateDir: state } : {}) })
    printResult({
      running: true,
      pid: started.health.pid,
      endpoint: started.health.wsUrl,
      headless: started.health.headless,
      noSandbox: started.health.noSandbox,
      browser: started.health.version,
      profile: options.profile ?? defaultProfilePath(), // the daemon's default, under the session's state directory
      ...(options.profileName ? { profileName: options.profileName, proxy: started.health.proxy, proxyOrigin: options.proxyOrigin } : {}),
      ...(started.health.proxyRoute ? { route: started.health.proxyRoute } : {}),
    })
    return 0
  }
  if (command === 'stop') {
    printResult(await stopHost(profileOptions(selection, {}, process.env)))
    return 0
  }
  if (command === 'status') {
    const chosen = profileOptions(selection, {}, process.env)
    const result = await status(chosen)
    printResult({
      ...(chosen.profileName ? { profile: chosen.profileName, userDataDir: chosen.profile,
        proxy: result.running ? result.health.proxy : (chosen.proxyPac ?? chosen.proxyServer ?? 'none'),
        proxyOrigin: chosen.proxyOrigin } : {}),
      running: result.running,
      ...(result.running ? { pid: result.health.pid, endpoint: result.health.wsUrl, headless: result.health.headless, pages: result.health.pages, browser: result.health.version } : {}),
    })
    return result.running ? 0 : 0
  }

  if (command === 'open') {
    const chosen = profileOptions(selection, {}, process.env, notify)
    const url = openUrl(rest.find((arg) => !arg.startsWith('--')), chosen.proxyCheckUrl)
    const rerouted = await rerouteIfDirect(chosen, { statusOf: status, stop: stopHost })
    if (rerouted) process.stderr.write(`open: ${rerouted.why}${rerouted.restarted ? '; restarted the browser' : ''}\n`)
    printResult(await callTool('new_page', { url }, chosen), { json: rest.includes('--json') })
    return 0
  }
  if (command === 'proxy-check') {
    const chosen = profileOptions(selection, {}, process.env, notify)
    let url = chosen.proxyCheckUrl
    let via = chosen.proxyCheckVia
    for (const arg of rest) {
      if (arg.startsWith('--url=')) url = arg.slice('--url='.length)
      else if (arg.startsWith('--via=')) via = arg.slice('--via='.length)
      else if (arg !== '--fix' && arg !== '--json') throw new Error(`unknown proxy-check option '${arg}'`)
    }
    const live = await status(chosen)
    if (!live.running) {
      process.stderr.write('no browser runs for this profile; start it first (cli.mjs --profile=NAME start)\n')
      return 1
    }
    const report = await proxyCheckReport({ wsUrl: live.health.wsUrl }, { url, via, fix: rest.includes('--fix') })
    if (rest.includes('--json')) printResult(report, { json: true })
    else {
      const lines = [`proxy: ${live.health.proxy?.join(' ') || 'none'}`,
        `proxy-controlling extensions enabled: ${report.extensions.map((e) => e.name).join(', ') || 'none'}` +
          (report.disabled.length > 0 ? ` (disabled now: ${report.disabled.map((e) => e.name).join(', ')})` : ''),
        url && via ? `route of ${url}: ${report.route?.error ?? `${report.route?.status} from ${report.route?.remote}`} ` +
          `(expected via ${via})` : 'route: no check URL (profile set NAME proxy_check.url=URL proxy_check.via=HOST:PORT)',
        report.ok ? 'ok' : `problem: ${report.problem}`]
      process.stdout.write(`${lines.join('\n')}\n`)
    }
    return report.ok ? 0 : 1
  }

  if (!TOOL_NAMES.includes(command)) {
    process.stderr.write(`there is no browser tool called '${command}'\n\n${USAGE}`)
    return 2
  }
  const json = rest.includes('--json')
  const args = parseToolArguments(rest.filter((arg) => arg !== '--json'))
  const result = await callTool(command, args, profileOptions(selection, {}, process.env, notify))
  printResult(result, { json })
  return 0
}


try {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
} catch (error) {
  process.stderr.write(`browser: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
