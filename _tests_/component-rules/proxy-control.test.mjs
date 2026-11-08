import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { clearSingleton, disableProxyControllers, enforceProxyPolicy, extensionArgs, holdsProfile, launchChrome,
  originalProfile, processAlive, processCommand, profileHeld, proxyExtensions, proxyRefusal } from '../../chrome.mjs'
import { refreshNote } from '../../profile-cli.mjs'
import { daemonArgs } from '../../client.mjs'

/**
 * Who really sets the proxy of a start (owner priority 2026-10-29 19.4x PDT, the [reflection] Coordinator's item
 * 20261029T163537Z): an enabled extension's proxy setting outranks --proxy-pac-url, and a second start on a profile a
 * running browser holds hands its flags over and drops them. Both must fail the start, saying why.
 */

const HELPER = 'abcdefghijklmnopabcdefghijklmnop'
const PAC = 'http://127.0.0.1:18085/site.pac'

function profileWith(settings, file = 'Secure Preferences') {
  const dir = mkdtempSync(join(tmpdir(), 'bu-proxy-'))
  mkdirSync(join(dir, 'Default'))
  writeFileSync(join(dir, 'Default', file), JSON.stringify({ extensions: { settings } }))
  return dir
}

const helper = (extra = {}) => ({
  [HELPER]: {
    manifest: { name: 'Proxy Helper', permissions: ['proxy'] },
    preferences: { proxy: { mode: 'pac_script', pac_url: 'data:application/x-ns-proxy-autoconfig;base64,AA==' } },
    regular_only_preferences: {},
    ...extra,
  },
})

test('an enabled extension that stores a proxy setting is found, by id and name', () => {
  const dir = profileWith({ ...helper(), other: { manifest: { name: 'No proxy' }, preferences: { homepage: 'x' } } })
  try {
    assert.deepEqual(proxyExtensions(dir), [{ id: HELPER, name: 'Proxy Helper' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a disabled extension, a profile without one and unreadable preferences find nothing', () => {
  for (const extra of [{ disable_reasons: [1] }, { disable_reasons: 1 }, { state: 0 }]) {
    const dir = profileWith(helper(extra))
    try {
      assert.deepEqual(proxyExtensions(dir), [], JSON.stringify(extra))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const empty = mkdtempSync(join(tmpdir(), 'bu-proxy-'))
  mkdirSync(join(empty, 'Default'))
  writeFileSync(join(empty, 'Default', 'Preferences'), '{not json')
  try {
    assert.deepEqual(proxyExtensions(empty), [])
    assert.deepEqual(proxyExtensions(join(empty, 'missing')), [])
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
  const plain = profileWith(helper(), 'Preferences')   // the plain Preferences file counts too
  try {
    assert.equal(proxyExtensions(plain).length, 1)
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test('a proxied start refuses an extension-controlled profile; an unproxied one does not care', () => {
  const ext = [{ id: HELPER, name: 'Proxy Helper' }]
  const refusal = proxyRefusal([`--proxy-pac-url=${PAC}`], '/p', ext)
  assert.match(refusal, /the extension Proxy Helper \(abcdefghijklmnopabcdefghijklmnop\) controls the proxy in \/p/)
  assert.match(refusal, /--disable-proxy-extensions/)
  assert.equal(proxyRefusal([], '/p', ext), undefined)
  assert.equal(proxyRefusal([`--proxy-pac-url=${PAC}`], '/p', []), undefined)
})

test('launchChrome fails before starting anything when an extension controls the proxy', async () => {
  const dir = profileWith(helper())
  try {
    await assert.rejects(launchChrome({ binary: '/usr/bin/false', profile: dir, proxyPac: PAC }),
      /Proxy Helper \(abcdefghijklmnopabcdefghijklmnop\) controls the proxy/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--disable-proxy-extensions adds --disable-extensions on a copy and is refused on ~/.heddle-browser', () => {
  const home = mkdtempSync(join(tmpdir(), 'bu-home-'))
  try {
    const original = join(home, '.heddle-browser', 'chrome-profile')
    mkdirSync(original, { recursive: true })
    const copy = join(home, 'copy', 'chrome-profile')
    mkdirSync(copy, { recursive: true })
    assert.equal(originalProfile(original, home), true)
    assert.equal(originalProfile(join(home, '.heddle-browser'), home), true)
    assert.equal(originalProfile(copy, home), false)
    symlinkSync(original, join(home, 'alias'))
    assert.equal(originalProfile(join(home, 'alias'), home), true, 'a link to the original is the original')
    assert.deepEqual(extensionArgs({ disableProxyExtensions: true }, copy, home), ['--disable-extensions'])
    assert.deepEqual(extensionArgs({}, copy, home), [])
    assert.throws(() => extensionArgs({ disableProxyExtensions: true }, original, home), /refused on .*a protected profile/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the daemon gets the opt-in flag', () => {
  assert.ok(daemonArgs({ disableProxyExtensions: true, cliPath: 'cli.mjs' }, '/s').includes('--disable-proxy-extensions'))
  assert.ok(!daemonArgs({ cliPath: 'cli.mjs' }, '/s').includes('--disable-proxy-extensions'))
})

test('only this profile\'s own running browser holds it; a dead or other-profile holder does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bu-held-'))
  // a live process whose command line names this profile, as its browser's does
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', `--user-data-dir=${dir}`],
    { stdio: 'ignore' })
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    symlinkSync(`${hostname()}-${holder.pid}`, join(dir, 'SingletonLock'))
    assert.match(processCommand(holder.pid), new RegExp(`--user-data-dir=${dir}`))   // read, not assumed
    assert.equal(holdsProfile(holder.pid, dir), 'yes')
    assert.match(profileHeld(dir), new RegExp(`held by a running browser \\(pid ${holder.pid}\\)`))
    await assert.rejects(launchChrome({ binary: '/usr/bin/false', profile: dir, proxyPac: PAC }),
      /would hand its flags \(a proxy among them\) to that browser/)
    assert.equal(profileHeld(dir, () => false), undefined, 'a dead holder is cleared by the start, as before')
    // Review B on PR 2133, B-I1: a copy of ~/.heddle-browser carries a lock naming the owner's live browser, which
    // holds another path; it is no holder of the copy, and nobody is told to kill it
    rmSync(join(dir, 'SingletonLock'))
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'))   // a live pid ...
    const owners = () => 'Google Chrome --user-data-dir=/Users/o/.heddle-browser/chrome-profile --no-first-run'
    assert.equal(holdsProfile(process.pid, dir, owners), 'no')   // ... whose browser holds another directory
    assert.equal(profileHeld(dir, processAlive, hostname(), owners), undefined)
    // a command line that cannot be judged counts as holding, and names no one to kill (Review A on PR 2133, A-I1)
    for (const unknown of [() => undefined, () => 'node test.mjs', () => 'chrome --user-data-dir=rel/profile']) {
      const said = profileHeld(dir, processAlive, hostname(), unknown)
      assert.match(said, /names no absolute --user-data-dir/)
      assert.doesNotMatch(said, /kill/)
    }
    rmSync(join(dir, 'SingletonLock'))
    symlinkSync('elsewhere-12', join(dir, 'SingletonLock'))
    assert.match(profileHeld(dir), /locked by 'elsewhere', another machine/)
    assert.equal(profileHeld(join(dir, 'none')), undefined)
  } finally {
    holder.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a holder and a start that name one profile by different spellings agree', () => {
  const base = mkdtempSync(join(tmpdir(), 'bu-spell-'))
  try {
    const real = join(base, 'real-profile')
    mkdirSync(real)
    symlinkSync(real, join(base, 'link'))
    const via = (path) => () => `chrome --user-data-dir=${path} --no-first-run`
    assert.equal(holdsProfile(1, real, via(join(base, 'link'))), 'yes', 'a holder started through a link')
    assert.equal(holdsProfile(1, join(base, 'link'), via(real)), 'yes', 'a start through a link')
    assert.equal(holdsProfile(1, real, via(`${real}/`)), 'yes', 'a trailing slash')
    assert.equal(holdsProfile(1, real, via(real.replace('/real-profile', '//real-profile'))), 'yes', "a '//'")
    assert.equal(holdsProfile(1, real, via(join(base, 'other'))), 'no')
    assert.equal(holdsProfile(1, real, () => 'chrome --no-first-run'), 'unknown', 'no --user-data-dir at all')
    // clearSingleton keeps a live holder's lock that names the profile by another spelling (the #572 A-M1 hazard)
    symlinkSync(`${hostname()}-${process.pid}`, join(real, 'SingletonLock'))
    assert.equal(clearSingleton(real, processAlive, hostname(), via(join(base, 'link'))), false)
    assert.equal(clearSingleton(real, processAlive, hostname(), via(join(base, 'other'))), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the GHE recipe copies no lock files', async () => {
  // since the profiles (PR 2569/2570) the recipe is a clone of sso, whose copy leaves Singleton* out
  // (profiles.test.mjs: 'a clone of sso copies the login and leaves its lock and caches behind')
  const { readFileSync } = await import('node:fs')
  const usage = readFileSync(new URL('../../usage.md', import.meta.url), 'utf8')
  assert.match(usage, /profile create ghe --clone=sso --proxy-pac=http:\/\/127\.0\.0\.1:18085\/site\.pac/)
  assert.doesNotMatch(usage, /cp -R ~\/\.heddle-browser/)
  assert.doesNotMatch(usage, /rsync[^\n]*\.heddle-browser(?![^\n]*Singleton)/, 'any manual copy excludes the locks')
})


// ---- 2026-11-02 (the [reflection] Coordinator, 01:5xZ): Chrome 156 kept Proxy Helper enabled under --disable-extensions,
// so disable-proxy-controllers disables the proxy-permission extensions through chrome.management after the start,
// verifies none is left, and fails loudly otherwise; a refreshed copy carries Proxy Helper again and every start handles it.

/** A fake DevTools connection: chrome://extensions answers the probe `ready` on the given try, then the report. */
function fakeConnection(report, { readyOn = 2, evaluateError } = {}) {
  const calls = []
  let probes = 0
  return {
    calls,
    connection: {
      async send(method, params = {}, options = {}) {
        calls.push([method, params.url ?? params.targetId ?? (params.expression?.startsWith('typeof') ? 'probe' : params.expression ? 'script' : ''), options.sessionId])
        if (method === 'Target.createTarget') return { result: { targetId: 'T1' } }
        if (method === 'Target.closeTarget') return { result: {} }
        if (method === 'Runtime.evaluate' && params.expression.startsWith('typeof')) {
          probes += 1
          return { result: { result: { value: probes >= readyOn } } }
        }
        if (method === 'Runtime.evaluate') {
          if (evaluateError) return { result: { exceptionDetails: { text: evaluateError } } }
          assert.equal(params.awaitPromise, true)
          return { result: { result: { value: JSON.stringify(report) } } }
        }
        throw new Error(`unexpected ${method}`)
      },
      async attach(targetId) {
        calls.push(['attach', targetId])
        return 'S1'
      },
      close() {
        calls.push(['close'])
      },
    },
  }
}

test('disableProxyControllers runs the script on chrome://extensions in its own target and closes it', async () => {
  const report = { disabled: [{ id: HELPER, name: 'Proxy Helper' }], failed: [], left: [] }
  const fake = fakeConnection(report)
  const got = await disableProxyControllers({ wsUrl: 'ws://x' }, { connectTo: async () => fake.connection })
  assert.deepEqual(got, report)
  assert.deepEqual(fake.calls, [['Target.createTarget', 'chrome://extensions', undefined], ['attach', 'T1'],
    ['Runtime.evaluate', 'probe', 'S1'], ['Runtime.evaluate', 'probe', 'S1'], ['Runtime.evaluate', 'script', 'S1'],
    ['Target.closeTarget', 'T1', undefined], ['close']])
  const broken = fakeConnection(report, { evaluateError: 'chrome.management is undefined' })
  await assert.rejects(disableProxyControllers({ wsUrl: 'ws://x' }, { connectTo: async () => broken.connection }),
    /returned no report/)
  assert.deepEqual(broken.calls.slice(-2), [['Target.closeTarget', 'T1', undefined], ['close']], 'closed on failure too')
})

test('enforceProxyPolicy: disables, verifies, and stops the browser loudly when a controller is left', async () => {
  const proxy = [`--proxy-pac-url=${PAC}`]
  const stops = []
  const deps = (report) => ({ disable: async () => report, stop: async (r) => stops.push(r) })
  const ok = { disabled: [{ id: HELPER, name: 'Proxy Helper' }], failed: [], left: [] }
  assert.deepEqual(await enforceProxyPolicy('R', { extensionsPolicy: 'disable-proxy-controllers' }, proxy, deps(ok)), ok.disabled)
  assert.deepEqual(await enforceProxyPolicy('R', { extensionsPolicy: 'disable-all' }, proxy, deps(ok)), ok.disabled,
    'disable-all is verified too: the flag alone was not enough')
  let called = false
  const never = { disable: async () => { called = true; return ok }, stop: async () => {} }
  assert.deepEqual(await enforceProxyPolicy('R', { extensionsPolicy: 'keep' }, proxy, never), [])
  assert.deepEqual(await enforceProxyPolicy('R', { extensionsPolicy: 'disable-proxy-controllers' }, [], never), [])
  assert.equal(called, false, 'keep, or no proxy: nothing to check')
  assert.deepEqual(stops, [])
  const left = { disabled: [], failed: [{ id: HELPER, error: 'cannot be disabled by policy' }],
    left: [{ id: HELPER, name: 'Proxy Helper', installType: 'admin' }] }
  await assert.rejects(enforceProxyPolicy('R', { extensionsPolicy: 'disable-proxy-controllers' }, proxy, deps(left)),
    /still enabled after disabling it: Proxy Helper \(abcdefghijklmnopabcdefghijklmnop, admin\) \(abcdefghijklmnopabcdefghijklmnop: cannot be disabled by policy\) - its proxy outranks --proxy-pac-url=/)
  assert.deepEqual(stops, ['R'], 'the browser is stopped')
  await assert.rejects(enforceProxyPolicy('R', { extensionsPolicy: 'disable-proxy-controllers' }, proxy,
    { disable: async () => { throw new Error('no chrome.management') }, stop: async (r) => stops.push(r) }),
  /could not check its extensions \(no chrome.management\)/)
  assert.deepEqual(stops, ['R', 'R'])
})

test('disable-proxy-controllers no longer refuses a copy whose prefs hold Proxy Helper (a refreshed copy): it reaches the browser', async () => {
  const dir = profileWith(helper())
  try {
    await assert.rejects(launchChrome({ binary: '/usr/bin/false', profile: dir, proxyPac: PAC, extensionsPolicy: 'keep' }),
      /controls the proxy/, 'keep still refuses before any start')
    await assert.rejects(launchChrome({ binary: '/usr/bin/false', profile: dir, proxyPac: PAC,
      extensionsPolicy: 'disable-proxy-controllers', noSandbox: true }),
    (error) => /before printing an endpoint/.test(error.message) && !/controls the proxy/.test(error.message))
    assert.throws(() => extensionArgs({ extensionsPolicy: 'disable-proxy-controllers', protectedProfile: true }, dir,
      '/h', [`--proxy-pac-url=${PAC}`]), /refused on .*a protected profile/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('profile refresh says the copy carries a proxy controller again, and what the next start does', () => {
  const found = () => [{ id: HELPER, name: 'Proxy Helper' }]
  const copy = { name: 'ghe', userDataDir: '/x', extensions: 'disable-proxy-controllers' }
  assert.equal(refreshNote(copy, found),
    `; the copy carries Proxy Helper (${HELPER}) enabled again - every start disables it (extensions: disable-proxy-controllers)`)
  assert.match(refreshNote({ ...copy, extensions: 'keep' }, found), /a proxied start refuses until `profile set ghe extensions=disable-proxy-controllers`/)
  assert.equal(refreshNote(copy, () => []), '')
})
