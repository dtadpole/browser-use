import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { closeTargetSurely, formatRemote, judgeRoute, probeRoute, proxyCheckReport, proxyControllerScript, PROXY_CONTROLLER_LIST_SCRIPT,
  verifyProxyRoute } from '../../chrome.mjs'
import { daemonArgs } from '../../client.mjs'
import { openUrl, profileOptions } from '../../profile-cli.mjs'
import { checkProxyCheck, createProfile, listLine, parseCreate, readProfile, setProfile, startSettings } from '../../profiles.mjs'

/**
 * A proxied start must not go direct without saying so (#5608, 2026-11-08): `--profile=ghe start` left Proxy Helper
 * enabled and every GHE page answered 403 from the direct path. Three guards: the extension check waits for
 * extensions to settle and looks again; a profile's route check loads a URL and requires it to come back through
 * the named proxy; `proxy-check` and `open` make the diagnosis and the GHE page one command each.
 */

const VIA = '127.0.0.1:18080'
const GHE = 'https://git.example.com/'
const PAC = 'http://127.0.0.1:18085/site.pac'
const FAST = { settleMs: 120, maxSettleMs: 2_000, recheckMs: 40, rounds: 3 }

/** A stand-in chrome.management whose extension list can change while the script runs. */
function management({ appearAfterMs = 0, reEnableOnce = false, locked = false } = {}) {
  const begun = Date.now()
  const helper = { id: 'vpn', name: 'Proxy Helper', enabled: true, permissions: ['proxy'], installType: 'sideload' }
  const other = { id: 'tel', name: 'Telemetry', enabled: true, permissions: ['tabs'], installType: 'sideload' }
  let reEnabled = false
  const calls = []
  return {
    calls,
    helper,
    api: {
      async getAll() {
        return Date.now() - begun >= appearAfterMs ? [other, helper].map((e) => ({ ...e })) : [{ ...other }]
      },
      async setEnabled(id, enabled) {
        calls.push([id, enabled])
        if (locked) throw new Error('cannot be disabled by policy')
        if (id === 'vpn') helper.enabled = enabled
        if (reEnableOnce && !reEnabled) {
          reEnabled = true
          setTimeout(() => { helper.enabled = true }, 10)   // something turns it back on right after
        }
      },
    },
  }
}

async function runScript(script, api) {
  const saved = globalThis.chrome
  globalThis.chrome = { management: api }
  try {
    return JSON.parse(await (0, eval)(script))
  } finally {
    globalThis.chrome = saved
  }
}

test('the extension check waits for a late extension before disabling (the #5608 race)', async () => {
  // Proxy Helper appears 300 ms after the page answers; a list that stays the same for 400 ms counts as settled
  const m = management({ appearAfterMs: 300 })
  const report = await runScript(proxyControllerScript({ ...FAST, settleMs: 400 }), m.api)
  assert.deepEqual(report.disabled.map((e) => e.name), ['Proxy Helper'])
  assert.deepEqual(report.left, [])
  assert.equal(m.helper.enabled, false)
  assert.ok(report.settledMs >= 700, `it waited for the list to settle (${report.settledMs} ms)`)
  // the old check (no settling, one look) misses it: the regression this pins
  const late = management({ appearAfterMs: 300 })
  const once = await runScript(proxyControllerScript({ settleMs: 0, maxSettleMs: 0, recheckMs: 0, rounds: 1 }), late.api)
  assert.deepEqual(once.disabled, [])
})

test('an extension turned back on after the first disable is disabled again', async () => {
  const m = management({ reEnableOnce: true })
  const report = await runScript(proxyControllerScript(FAST), m.api)
  assert.equal(report.disabled.length, 2, 'two rounds')
  assert.deepEqual(report.left, [])
})

test('an extension that cannot be disabled is reported left, with why', async () => {
  const m = management({ locked: true })
  const report = await runScript(proxyControllerScript(FAST), m.api)
  assert.deepEqual(report.left, [{ id: 'vpn', name: 'Proxy Helper', installType: 'sideload' }])
  assert.match(report.failed[0].error, /by policy/)
})

test('the list script changes nothing', async () => {
  const m = management()
  const report = await runScript(PROXY_CONTROLLER_LIST_SCRIPT, m.api)
  assert.deepEqual(report.left.map((e) => e.name), ['Proxy Helper'])
  assert.deepEqual(m.calls, [])
})

test('judgeRoute: through the named proxy passes; direct or failed says what happened', () => {
  assert.equal(judgeRoute({ url: GHE, status: 200, remote: VIA, server: 'GitHub.com' }, VIA), undefined)
  assert.notEqual(judgeRoute({ url: GHE, status: 200, remote: '52.1.2.3:443', server: 'GitHub.com' }, VIA), undefined,
    'a 200 that came direct is still a failure: the route is the verdict, not the status')
  const direct = judgeRoute({ url: GHE, status: 403, remote: '52.1.2.3:443', server: 'edge-lb/1.0' }, VIA)
  assert.match(direct, /went around the proxy: https:\/\/git.example.com\/ answered 403 from 52.1.2.3:443 \(server: edge-lb\/1.0\), not through 127.0.0.1:18080/)
  assert.match(direct, /proxy-check/)
  assert.match(judgeRoute({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, VIA), /did not load \(net::ERR_PROXY_CONNECTION_FAILED\): is the proxy 127.0.0.1:18080 up/)
})

test('A-M1: an IPv6 loopback proxy and a bracketed via compare by host and port', () => {
  assert.equal(judgeRoute({ url: GHE, status: 200, remote: '[::1]:18080' }, '[::1]:18080'), undefined)
  assert.equal(judgeRoute({ url: GHE, status: 200, remote: '[::1]:18080' }, 'localhost:18080'), undefined,
    'any loopback name is the same local forward')
  assert.equal(judgeRoute({ url: GHE, status: 200, remote: '127.0.0.1:18080' }, 'localhost:18080'), undefined)
  assert.notEqual(judgeRoute({ url: GHE, status: 200, remote: '127.0.0.1:18081' }, VIA), undefined, 'another port')
  assert.notEqual(judgeRoute({ url: GHE, status: 200, remote: '10.0.0.1:18080' }, VIA), undefined, 'another host')
  assert.equal(formatRemote('::1', 18080), '[::1]:18080')
  assert.equal(formatRemote('127.0.0.1', 18080), '127.0.0.1:18080')
  assert.equal(formatRemote('', 0), '')
})

test('verifyProxyRoute: nothing to check, a pass, and a failure that stops the browser', async () => {
  const stops = []
  const deps = (result) => ({ probe: async () => result, stop: async (r) => stops.push(r) })
  const proxy = [`--proxy-pac-url=${PAC}`]
  assert.equal(await verifyProxyRoute('R', {}, proxy, deps({})), undefined)
  assert.equal(await verifyProxyRoute('R', { proxyCheckUrl: GHE, proxyCheckVia: VIA }, [], deps({})), undefined,
    'no proxy at this start: the check does not apply')
  const ok = { url: GHE, status: 200, remote: VIA, server: 'GitHub.com' }
  assert.deepEqual(await verifyProxyRoute('R', { proxyCheckUrl: GHE, proxyCheckVia: VIA }, proxy, deps(ok)), ok)
  assert.deepEqual(stops, [])
  await assert.rejects(verifyProxyRoute('R', { proxyCheckUrl: GHE, proxyCheckVia: VIA }, proxy,
    deps({ url: GHE, status: 403, remote: '52.1.2.3:443', server: 'edge-lb/1.0' })), /went around the proxy.*the browser was stopped/)
  await assert.rejects(verifyProxyRoute('R', { proxyCheckUrl: GHE, proxyCheckVia: VIA }, proxy,
    { probe: async () => { throw new Error('socket closed') }, stop: async (r) => stops.push(r) }), /did not load \(socket closed\)/)
  assert.deepEqual(stops, ['R', 'R'])
})

/** A connection that answers Page.navigate with the given events, as Chrome would. */
function routeConnection(events) {
  const listeners = new Map()
  const calls = []
  return {
    calls,
    connection: {
      on(method, handler) {
        const list = listeners.get(method) ?? []
        list.push(handler)
        listeners.set(method, list)
        return () => list.splice(list.indexOf(handler), 1)
      },
      async send(method, params = {}, options = {}) {
        calls.push([method, options.sessionId])
        if (method === 'Target.createTarget') return { result: { targetId: 'T9' } }
        if (method === 'Page.navigate') {
          setTimeout(() => {
            for (const [name, payload, sessionId] of events) {
              for (const handler of listeners.get(name) ?? []) handler(payload, { sessionId })
            }
          }, 5)
        }
        return { result: {} }
      },
      async attach() {
        return 'S9'
      },
      close() {
        calls.push(['close'])
      },
    },
  }
}

test('probeRoute reads the document response of its own target, headers in any case', async () => {
  const other = { type: 'Document', response: { url: 'x', status: 200, remoteIPAddress: '9.9.9.9', remotePort: 443, headers: {} } }
  const mine = { type: 'Document', response: { url: GHE, status: 200, remoteIPAddress: '127.0.0.1', remotePort: 18080,
    headers: { Server: 'GitHub.com' } } }
  const image = { type: 'Image', response: { url: 'i', status: 200, remoteIPAddress: '8.8.8.8', remotePort: 443, headers: {} } }
  const fake = routeConnection([['Network.responseReceived', other, 'S1'], ['Network.responseReceived', image, 'S9'],
    ['Network.responseReceived', mine, 'S9']])
  const got = await probeRoute({ wsUrl: 'ws://x' }, GHE, { connectTo: async () => fake.connection })
  assert.deepEqual(got, { url: GHE, status: 200, remote: VIA, server: 'GitHub.com' })
  const disabled = fake.calls.findIndex(([m]) => m === 'Network.setCacheDisabled')
  assert.ok(disabled >= 0 && disabled < fake.calls.findIndex(([m]) => m === 'Page.navigate'),
    'A-M1: the cache is off before the probe loads, so the answer names the route it took')
  assert.deepEqual(fake.calls.slice(-4), [['Page.stopLoading', 'S9'], ['Target.closeTarget', undefined],
    ['Target.getTargets', undefined], ['close']], 'loading stopped, the target closed and seen gone')
})

test('closeTargetSurely repeats a close Chrome acknowledged but did not do, and gives up quietly', async () => {
  const make = (closesNeeded) => {
    let closes = 0
    return {
      get closes() { return closes },
      async send(method) {
        if (method === 'Target.closeTarget') { closes += 1; return { result: { success: true } } }
        if (method === 'Target.getTargets') {
          return { result: { targetInfos: closes >= closesNeeded ? [] : [{ targetId: 'T9', type: 'page' }] } }
        }
        return { result: {} }
      },
    }
  }
  const second = make(2)
  assert.equal(await closeTargetSurely(second, 'T9', { intervalMs: 5 }), true)
  assert.equal(second.closes, 2)
  const never = make(Infinity)
  assert.equal(await closeTargetSurely(never, 'T9', { intervalMs: 5, timeoutMs: 40 }), false)
  assert.ok(never.closes >= 2)
})

test('probeRoute reports a failed load and a silent one', async () => {
  const failed = routeConnection([['Network.loadingFailed', { type: 'Document', errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, 'S9']])
  assert.deepEqual(await probeRoute({ wsUrl: 'ws://x' }, GHE, { connectTo: async () => failed.connection }),
    { error: 'net::ERR_TUNNEL_CONNECTION_FAILED' })
  const silent = routeConnection([])
  assert.match((await probeRoute({ wsUrl: 'ws://x' }, GHE, { connectTo: async () => silent.connection, timeoutMs: 50 })).error,
    /no document within 50ms/)
})

test('proxyCheckReport: lists without changing, fixes on request, and joins both problems', async () => {
  const seen = []
  const left = [{ id: 'vpn', name: 'Proxy Helper', installType: 'sideload' }]
  const disable = async (running, opts) => {
    seen.push(opts.script === PROXY_CONTROLLER_LIST_SCRIPT ? 'list' : 'fix')
    return opts.script ? { disabled: [], failed: [], left } : { disabled: left, failed: [], left: [] }
  }
  const direct = async () => ({ url: GHE, status: 403, remote: '52.1.2.3:443', server: 'edge-lb/1.0' })
  const through = async () => ({ url: GHE, status: 200, remote: VIA, server: 'GitHub.com' })
  let r = await proxyCheckReport('R', { url: GHE, via: VIA }, { disable, probe: direct })
  assert.equal(r.ok, false)
  assert.match(r.problem, /enabled with the proxy permission: Proxy Helper .*--fix.*; the browser went around the proxy/)
  r = await proxyCheckReport('R', { url: GHE, via: VIA, fix: true }, { disable, probe: through })
  assert.equal(r.ok, true)
  assert.deepEqual(r.disabled.map((e) => e.name), ['Proxy Helper'])
  r = await proxyCheckReport('R', {}, { disable: async () => ({ disabled: [], failed: [], left: [] }), probe: direct })
  assert.equal(r.ok, true, 'no check URL: only the extensions are judged')
  assert.deepEqual(seen, ['list', 'fix'])
})

test('a profile route check: both parts or neither, a real URL, host:port', () => {
  checkProxyCheck(undefined)
  checkProxyCheck({ url: null, via: null })
  checkProxyCheck({ url: GHE, via: VIA })
  checkProxyCheck({ url: GHE, via: '[::1]:18080' })   // A-M1: an IPv6 loopback forward
  assert.throws(() => checkProxyCheck({ url: GHE }), /needs both a url and a via/)
  assert.throws(() => checkProxyCheck({ url: 'ftp://x/', via: VIA }), /http or https/)
  assert.throws(() => checkProxyCheck({ url: 'not a url', via: VIA }), /is not a URL/)
  assert.throws(() => checkProxyCheck({ url: GHE, via: 'http://127.0.0.1:18080' }), /is not host:port/)
})

test('create, set and list carry the route check; a start applies it only to the profile\'s own proxy', () => {
  const base = mkdtempSync(join(tmpdir(), 'bu-route-'))
  try {
    const ctx = { root: join(base, 'root'), home: join(base, 'home'), env: {}, now: () => new Date('2026-11-08T04:00:00Z') }
    mkdirSync(join(ctx.home, '.heddle-browser', 'chrome-profile', 'Default'), { recursive: true })
    writeFileSync(join(ctx.home, '.heddle-browser', 'chrome-profile', 'Local State'), '{}')
    const parsed = parseCreate(['ghe', '--clone=sso', `--proxy-pac=${PAC}`, `--proxy-check-url=${GHE}`, `--proxy-check-via=${VIA}`])
    assert.deepEqual(parsed.options.proxy_check, { url: GHE, via: VIA })
    createProfile('ghe', parsed.options, ctx)
    let ghe = readProfile('ghe', ctx)
    assert.deepEqual(ghe.proxy_check, { url: GHE, via: VIA })
    assert.match(listLine(ghe, undefined), /proxy: http:\/\/127.0.0.1:18085\/site.pac \(checked via 127.0.0.1:18080\);/)
    assert.throws(() => setProfile('ghe', ['proxy_check.via=nonsense'], ctx), /is not host:port/)
    setProfile('ghe', ['proxy_check.url=none', 'proxy_check.via=none'], ctx)
    ghe = readProfile('ghe', ctx)
    assert.doesNotMatch(listLine(ghe, undefined), /checked via/)
    setProfile('ghe', [`proxy_check.url=${GHE}`, `proxy_check.via=${VIA}`], ctx)
    ghe = readProfile('ghe', ctx)
    let s = startSettings(ghe, {}, {})
    assert.deepEqual([s.proxyCheckUrl, s.proxyCheckVia], [GHE, VIA])
    s = startSettings(ghe, { proxyServer: '127.0.0.1:1' }, {})
    assert.deepEqual([s.proxyCheckUrl, s.proxyCheckVia], [undefined, undefined])
    assert.ok(s.notices.some((n) => /route check .* is skipped for the overriding proxy/.test(n)))
    const options = profileOptions({ kind: 'name', profile: ghe }, {}, {})
    assert.deepEqual([options.proxyCheckUrl, options.proxyCheckVia], [GHE, VIA])
    const args = daemonArgs({ ...options, cliPath: '/c' }, '/state')
    assert.ok(args.includes(`--proxy-check-url=${GHE}`) && args.includes(`--proxy-check-via=${VIA}`))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('open: a URL as given, a path under the profile home, and a clear refusal without either', () => {
  assert.equal(openUrl('https://example.com/a', GHE), 'https://example.com/a')
  assert.equal(openUrl('https://example.com/a', undefined), 'https://example.com/a', 'a URL needs no profile home')
  assert.equal(openUrl(undefined, GHE), GHE)
  assert.equal(openUrl('reflection/reflection', GHE), 'https://git.example.com/reflection/reflection')
  assert.equal(openUrl('/reflection/reflection/pull/5498', 'https://git.example.com'),
    'https://git.example.com/reflection/reflection/pull/5498')
  assert.throws(() => openUrl('reflection', undefined), /open needs a URL, or a profile with a home/)
})
