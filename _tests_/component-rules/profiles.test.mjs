import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { extensionArgs } from '../../chrome.mjs'
import { daemonArgs } from '../../client.mjs'
import { profileCommand, profileOptions, profileRunning } from '../../profile-cli.mjs'
import { addExternal, copyUserData, createProfile, isPathValue, listLine, listProfiles, parseCreate, readProfile,
  refreshProfile, registryRoot, removeRegistered, selectProfile, setProfile, startSettings } from '../../profiles.mjs'

/**
 * Profiles as browser-use's core notion (owner request 2026-10-30, the [reflection] Coordinator's item
 * 20261030T133505Z): the registry, copying, protection, the settings a start applies, and the --profile rule.
 * Every test runs on a scratch root and a scratch home; nothing touches ~/.heddle-browser or ~/.browser-use.
 */

const PAC = 'http://127.0.0.1:18085/site.pac'
/** Whether a path exists as an entry, a dangling link included (existsSync follows links). */
const present = (path) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const NOW = () => new Date('2026-10-30T14:00:00Z')

function world() {
  const base = mkdtempSync(join(tmpdir(), 'bu-profiles-'))
  const home = join(base, 'home')
  const root = join(base, 'root')
  // a stand-in SSO profile: a login, a lock naming a live browser, and caches
  const sso = join(home, '.heddle-browser', 'chrome-profile')
  mkdirSync(join(sso, 'Default', 'Cache'), { recursive: true })
  mkdirSync(join(sso, 'Default', 'Code Cache', 'js'), { recursive: true })
  writeFileSync(join(sso, 'Default', 'Cookies'), 'cookie-db')
  writeFileSync(join(sso, 'Default', 'Cache', 'data_0'), 'cache')
  writeFileSync(join(sso, 'Local State'), '{}')
  symlinkSync('host-86861', join(sso, 'SingletonLock'))
  symlinkSync('/tmp/nowhere/SingletonSocket', join(sso, 'SingletonSocket'))
  const ctx = { root, home, env: {}, now: NOW }
  return { base, home, root, sso, ctx, done: () => rmSync(base, { recursive: true, force: true }) }
}

test('an empty registry lists default and the protected sso reference', () => {
  const w = world()
  try {
    const list = listProfiles(w.ctx)
    assert.deepEqual(list.map((p) => [p.name, p.protected]), [['default', false], ['sso', true]])
    assert.equal(list[0].userDataDir, join(w.root, 'chrome-profile'), 'default is today\'s layout')
    assert.equal(list[0].sessionDir, w.root)
    assert.equal(list[1].userDataDir, w.sso)
    assert.equal(list[1].sessionDir, join(w.root, 'profiles', 'sso', 'session'), 'sso\'s session files never go into ~/.heddle-browser')
    assert.throws(() => readProfile('ghe', w.ctx), /there is no profile 'ghe' \(profiles: default, sso\)/)
  } finally {
    w.done()
  }
})

test('a clone of sso copies the login and leaves its lock and caches behind', () => {
  const w = world()
  try {
    const ghe = createProfile('ghe', { clone: 'sso', proxy: { pac: PAC }, extensions: 'disable-proxy-controllers',
      description: 'GHE as me' }, w.ctx)
    assert.equal(readFileSync(join(ghe.userDataDir, 'Default', 'Cookies'), 'utf8'), 'cookie-db')
    for (const gone of ['SingletonLock', 'SingletonSocket', join('Default', 'Cache'), join('Default', 'Code Cache')]) {
      assert.equal(present(join(ghe.userDataDir, gone)), false, gone)
    }
    assert.deepEqual(ghe.source, { kind: 'copy', from: 'sso', copied_at: '2026-10-30T14:00:00.000Z' })
    assert.equal(ghe.proxy.pac, PAC)
    assert.equal(ghe.userDataDir, join(w.root, 'profiles', 'ghe', 'chrome-profile'))
    assert.equal(ghe.sessionDir, join(w.root, 'profiles', 'ghe', 'session'))
    assert.equal(present(join(w.sso, 'SingletonLock')), true, 'the source is untouched')
    assert.deepEqual(listProfiles(w.ctx).map((p) => p.name), ['default', 'sso', 'ghe'])
    const fromPath = createProfile('copy2', { from: w.sso }, w.ctx)
    assert.deepEqual(fromPath.source.kind, 'copy')
    assert.equal(fromPath.source.from, w.sso)
    const fresh = createProfile('blank', {}, w.ctx)
    assert.equal(fresh.source.kind, 'fresh')
    assert.equal(existsSync(fresh.userDataDir), true)
  } finally {
    w.done()
  }
})

test('names, reserved names, duplicates and bad settings are refused', () => {
  const w = world()
  try {
    for (const bad of ['Ghe', '1x', 'a b', '', 'x'.repeat(41)]) assert.throws(() => createProfile(bad, {}, w.ctx), /is not a profile name/)
    assert.throws(() => createProfile('sso', {}, w.ctx), /built-in profile/)
    assert.throws(() => createProfile('default', {}, w.ctx), /built-in profile/)
    createProfile('one', {}, w.ctx)
    assert.throws(() => createProfile('one', {}, w.ctx), /already exists/)
    assert.throws(() => createProfile('two', { from: w.sso, clone: 'sso' }, w.ctx), /not both/)
    assert.throws(() => createProfile('three', { proxy: { pac: 'file:///x.pac' } }, w.ctx), /must be an http/)
    assert.throws(() => createProfile('four', { extensions: 'some' }, w.ctx), /extensions must be one of/)
    assert.throws(() => createProfile('five', { from: join(w.base, 'missing') }, w.ctx), /does not exist/)
    assert.equal(existsSync(join(w.root, 'profiles', 'three', 'profile.json')), false, 'a refused create writes nothing')
  } finally {
    w.done()
  }
})

test('protection: sso and external references are never set, refreshed or removed with their data', () => {
  const w = world()
  try {
    assert.throws(() => setProfile('sso', ['proxy.pac=' + PAC], w.ctx), /built-in/)
    assert.throws(() => refreshProfile('sso', {}, w.ctx), /protected/)
    assert.throws(() => removeRegistered('sso', {}, w.ctx), /built-in/)
    const ext = addExternal('mine', w.sso, { description: 'by reference' }, w.ctx)
    assert.equal(ext.protected, true)
    assert.equal(ext.userDataDir, w.sso)
    assert.throws(() => setProfile('mine', ['extensions=disable-all'], w.ctx), /protected: only its description/)
    assert.equal(setProfile('mine', ['description=renamed'], w.ctx).description, 'renamed')
    assert.throws(() => refreshProfile('mine', {}, w.ctx), /protected/)
    const removed = removeRegistered('mine', {}, w.ctx)
    assert.equal(removed.kept, w.sso)
    assert.equal(existsSync(join(w.sso, 'Default', 'Cookies')), true, 'removing a reference never touches its data')
    // a protected profile is never started with extensions disabled
    assert.throws(() => extensionArgs({ extensionsPolicy: 'disable-all', protectedProfile: true }, join(w.base, 'p'), w.home),
      /refused on .*a protected profile/)
  } finally {
    w.done()
  }
})

test('set, re-pointed source, refresh and remove of a copy', () => {
  const w = world()
  try {
    createProfile('ghe', { from: w.sso }, w.ctx)
    const set = setProfile('ghe', ['proxy.pac=' + PAC, 'headless=true', 'source=sso'], w.ctx)
    assert.equal(set.proxy.pac, PAC)
    assert.equal(set.headless, true)
    assert.equal(set.source.from, 'sso', 'refresh can be re-pointed at the live SSO profile')
    assert.throws(() => setProfile('ghe', ['source=nobody'], w.ctx), /there is no profile 'nobody'/)
    assert.throws(() => setProfile('ghe', ['proxy.pac=file:///x'], w.ctx), /must be an http/)
    assert.throws(() => setProfile('ghe', ['colour=red'], w.ctx), /cannot be set/)
    writeFileSync(join(w.sso, 'Default', 'Cookies'), 'renewed-login')
    assert.throws(() => refreshProfile('ghe', { running: true }, w.ctx), /is running/)
    const later = { ...w.ctx, now: () => new Date('2026-11-01T09:00:00Z') }
    const fresh = refreshProfile('ghe', {}, later)
    assert.equal(readFileSync(join(fresh.userDataDir, 'Default', 'Cookies'), 'utf8'), 'renewed-login')
    assert.equal(fresh.proxy.pac, PAC, 'refresh keeps the settings')
    assert.equal(fresh.source.copied_at, '2026-11-01T09:00:00.000Z')
    assert.equal(present(join(fresh.userDataDir, 'SingletonLock')), false)
    createProfile('blank', {}, w.ctx)
    assert.throws(() => refreshProfile('blank', {}, w.ctx), /not copied from anything/)
    assert.throws(() => removeRegistered('ghe', { running: true }, w.ctx), /is running/)
    removeRegistered('ghe', {}, w.ctx)
    assert.equal(existsSync(join(w.root, 'profiles', 'ghe')), false)
    assert.throws(() => removeRegistered('default', {}, w.ctx), /built-in/)
  } finally {
    w.done()
  }
})

test('a start applies the profile, and the start flag, then the environment, override it with a notice', () => {
  const profile = { name: 'ghe', proxy: { pac: PAC, server: null }, extensions: 'disable-proxy-controllers', headless: false, protected: false }
  let s = startSettings(profile, {}, {})
  assert.deepEqual([s.proxyPac, s.proxyServer, s.proxyOrigin, s.extensions, s.headless, s.notices], [PAC, undefined, 'profile', 'disable-proxy-controllers', false, []])
  s = startSettings(profile, {}, { HEDDLE_BROWSER_PROXY_SERVER: '127.0.0.1:1' })
  assert.deepEqual([s.proxyPac, s.proxyServer, s.proxyOrigin], [undefined, '127.0.0.1:1', 'env'])
  assert.match(s.notices[0], /profile ghe: its proxy .*site.pac is overridden by the environment \(127.0.0.1:1\)/)
  s = startSettings(profile, { proxyPac: 'http://x/y.pac' }, { HEDDLE_BROWSER_PROXY_PAC: 'http://e/e.pac' })
  assert.deepEqual([s.proxyPac, s.proxyOrigin], ['http://x/y.pac', 'flag'])
  assert.match(s.notices[0], /overridden by the start flag/)
  assert.equal(startSettings({ ...profile, proxy: {} }, {}, {}).proxyOrigin, 'none')
  assert.equal(startSettings(profile, { headless: true }, {}).headless, true)
  assert.equal(startSettings(profile, {}, { HEDDLE_BROWSER_HEADLESS: '1' }).headless, true)
  assert.equal(startSettings({ ...profile, headless: true }, {}, {}).headless, true)
  assert.equal(startSettings(profile, { disableProxyExtensions: true }, {}).extensions, 'disable-all')
  assert.equal(startSettings({ ...profile, protected: true }, {}, {}).protectedProfile, true)
})

test('the extension policy: keep, disable-all, and disable-proxy-controllers (no flag: it acts on the running browser)', () => {
  const ctrl = () => [{ id: 'x', name: 'Proxy Helper' }]
  const none = () => []
  const p = '/scratch/profile'
  const proxy = [`--proxy-pac-url=${PAC}`]
  assert.deepEqual(extensionArgs({ extensionsPolicy: 'keep' }, p, '/h', proxy, ctrl), [])
  assert.deepEqual(extensionArgs({ extensionsPolicy: 'disable-all' }, p, '/h', [], none), ['--disable-extensions'])
  // 2026-11-02: Chrome 156 kept Proxy Helper enabled under --disable-extensions; the policy now disables the proxy
  // controllers through chrome.management after the start (enforceProxyPolicy), so it adds no flag
  assert.deepEqual(extensionArgs({ extensionsPolicy: 'disable-proxy-controllers' }, p, '/h', proxy, ctrl), [])
  assert.deepEqual(extensionArgs({ extensionsPolicy: 'disable-proxy-controllers' }, p, '/h', [], ctrl), [], 'no proxy: nothing to win against')
  assert.deepEqual(extensionArgs({ extensionsPolicy: 'disable-proxy-controllers' }, p, '/h', proxy, none), [], 'no controller in the prefs')
  assert.deepEqual(extensionArgs({ disableProxyExtensions: true }, p, '/h'), ['--disable-extensions'], 'the #2133 flag')
})

test('--profile: a path is today\'s user-data dir, a name must be registered, and it does not combine with --session', () => {
  const w = world()
  try {
    for (const v of ['/abs/dir', '~/x', './rel', '../up', 'a/b', '~', '.', '..']) assert.equal(isPathValue(v), true, v)
    for (const v of ['ghe', 'sso', 'default']) assert.equal(isPathValue(v), false, v)
    let r = selectProfile(['--profile=~/dir', 'start'], w.ctx)
    assert.deepEqual(r, { argv: ['start'], selection: { kind: 'path', path: join(w.home, 'dir') } })
    r = selectProfile(['take_snapshot', '--profile=sso'], w.ctx)
    assert.deepEqual([r.argv, r.selection.kind, r.selection.profile.name], [['take_snapshot'], 'name', 'sso'])
    assert.deepEqual(selectProfile(['status'], w.ctx), { argv: ['status'], selection: undefined })
    assert.throws(() => selectProfile(['--profile=ghe', 'status'], w.ctx), /there is no profile 'ghe'/)
    assert.throws(() => selectProfile(['--profile=sso', '--session=x', 'status'], w.ctx), /do not combine/)
    assert.throws(() => selectProfile(['--profile=sso', 'status'], { ...w.ctx, env: { HEDDLE_BROWSER_SESSION: 'x' } }), /do not combine/)
    assert.throws(() => selectProfile(['--profile=a', '--profile=b'], w.ctx), /more than once/)
    assert.throws(() => selectProfile(['--profile='], w.ctx), /needs a profile name or a path/)
  } finally {
    w.done()
  }
})

test('profileOptions maps a profile onto the start options; a path keeps today\'s meaning with a notice', () => {
  const w = world()
  try {
    createProfile('ghe', { clone: 'sso', proxy: { pac: PAC }, extensions: 'disable-proxy-controllers' }, w.ctx)
    const picked = selectProfile(['--profile=ghe'], w.ctx).selection
    const o = profileOptions(picked, {}, {})
    assert.equal(o.stateDir, join(w.root, 'profiles', 'ghe', 'session'))
    assert.equal(o.profile, join(w.root, 'profiles', 'ghe', 'chrome-profile'))
    assert.deepEqual([o.profileName, o.proxyPac, o.proxyOrigin, o.extensionsPolicy, o.protectedProfile], ['ghe', PAC, 'profile', 'disable-proxy-controllers', false])
    const notes = []
    profileOptions(picked, {}, { HEDDLE_BROWSER_PROXY_PAC: 'http://e/e.pac' }, (n) => notes.push(n))
    assert.equal(notes.length, 1)
    const legacy = profileOptions({ kind: 'path', path: '/some/dir' }, { headless: true }, {}, (n) => notes.push(n))
    assert.deepEqual(legacy, { headless: true, profile: '/some/dir' })
    assert.match(notes[1], /unregistered user-data dir/)
    assert.deepEqual(profileOptions(undefined, { headless: true }, {}), { headless: true }, 'no --profile: today\'s behaviour')
    const args = daemonArgs({ ...o, cliPath: 'cli.mjs' }, '/s')
    for (const a of ['--extensions=disable-proxy-controllers', '--profile-name=ghe', `--proxy-pac=${PAC}`]) assert.ok(args.includes(a), a)
    assert.ok(daemonArgs({ protectedProfile: true, cliPath: 'cli.mjs' }, '/s').includes('--protected'))
    assert.ok(!daemonArgs({ extensionsPolicy: 'keep', cliPath: 'cli.mjs' }, '/s').some((a) => a.startsWith('--extensions')))
  } finally {
    w.done()
  }
})

test('the profile command: create, list with sources, show, set, refresh, remove', async () => {
  const w = world()
  try {
    const run = (args, running) => profileCommand(args, { running: running ?? (async () => undefined) }, w.ctx)
    assert.match(await run(['create', 'ghe', '--clone=sso', `--proxy-pac=${PAC}`, '--disable-proxy-extensions', '--description=GHE']), /created ghe: source copy of sso/)
    const list = await run(['list'], async (p) => (p.name === 'ghe' ? 4242 : undefined))
    const lines = list.split('\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0], /^default\s+source: fresh; proxy: none; extensions: keep; running: no$/)
    assert.match(lines[1], new RegExp(`^sso\\s+protected source: external ${w.sso}`))
    assert.match(lines[2], /^ghe\s+source: copy of sso \(copied 2026-10-30T14:00Z\); proxy: http:\/\/127.0.0.1:18085\/site.pac; extensions: disable-proxy-controllers; running: pid 4242$/)
    assert.match(await run(['show', 'ghe']), /user-data dir: .*profiles\/ghe\/chrome-profile/)
    assert.match(await run(['set', 'ghe', 'headless=true']), /headless by default: true/)
    await assert.rejects(run(['refresh', 'ghe'], async () => 99), /is running/)
    assert.match(await run(['refresh', 'ghe']), /refreshed ghe from sso/)
    assert.match(await run(['add', 'ext', `--external=${w.sso}`]), /protected reference/)
    assert.match(await run(['remove', 'ext']), /is untouched/)
    assert.match(await run(['remove', 'ghe']), /removed ghe/)
    await assert.rejects(run(['create']), /needs a NAME/)
    await assert.rejects(run(['create', 'x', '--external=/p']), /belongs to `profile add/)
    await assert.rejects(run(['add', 'x']), /needs --external/)
    await assert.rejects(run(['rename', 'x']), /unknown profile command/)
    assert.deepEqual(parseCreate(['n', '--extensions=disable-all', '--headless', '--proxy-server=h:1']).options,
      { extensions: 'disable-all', headless: true, proxy: { server: 'h:1' } })
    assert.throws(() => parseCreate(['n', '--bogus']), /unknown profile option/)
  } finally {
    w.done()
  }
})

test('copyUserData refuses a missing source and copies nested files but no Singleton* at any depth', () => {
  const w = world()
  try {
    assert.throws(() => copyUserData(join(w.base, 'none'), join(w.base, 'dst')), /does not exist/)
    writeFileSync(join(w.sso, 'Default', 'SingletonCookie'), 'x')
    copyUserData(w.sso, join(w.base, 'dst'))
    assert.equal(existsSync(join(w.base, 'dst', 'Local State')), true)
    assert.equal(existsSync(join(w.base, 'dst', 'Default', 'SingletonCookie')), false)
  } finally {
    w.done()
  }
})

test('with HEDDLE_BROWSER_HOME on the SSO home, the registry never writes into it (Review A on PR 2569, A-M1)', () => {
  const w = world()
  try {
    const ssoHome = join(w.home, '.heddle-browser')
    const ctx = { home: w.home, env: { HEDDLE_BROWSER_HOME: ssoHome }, now: NOW }
    assert.equal(registryRoot(ssoHome, ctx.env, w.home), join(w.home, '.browser-use', 'browser'))
    assert.equal(registryRoot(join(ssoHome, 'sub'), ctx.env, w.home), join(w.home, '.browser-use', 'browser'))
    assert.equal(registryRoot(w.root, ctx.env, w.home), w.root, 'any other root is the registry')
    symlinkSync(ssoHome, join(w.base, 'alias'))
    assert.equal(registryRoot(join(w.base, 'alias'), ctx.env, w.home), join(w.home, '.browser-use', 'browser'),
      'a link to the SSO home is the SSO home (Review A on PR 2581, A-M1)')
    const ghe = createProfile('ghe', { clone: 'sso' }, ctx)
    assert.equal(ghe.dir, join(w.home, '.browser-use', 'browser', 'profiles', 'ghe'))
    assert.equal(present(join(ssoHome, 'profiles')), false, 'nothing is written into ~/.heddle-browser')
    const sso = readProfile('sso', ctx)
    assert.equal(sso.sessionDir.startsWith(ssoHome), false)
    assert.equal(readProfile('default', ctx).userDataDir, join(ssoHome, 'chrome-profile'), 'default still follows HEDDLE_BROWSER_HOME')
  } finally {
    w.done()
  }
})

test('a profile held by a browser outside the registry reads as held, and refresh refuses it (Review B on PR 2569, B-M2)', async () => {
  const p = { userDataDir: '/u', sessionDir: '/s' }
  const holder = () => ({ host: 'h', pid: 86861, foreign: false })
  assert.equal(await profileRunning(p, { live: async () => 4242, holder }), 4242, 'this registry\'s host first')
  assert.deepEqual(await profileRunning(p, { live: async () => undefined, holder, alive: () => true, holds: () => 'yes' }), { held: 86861 })
  assert.deepEqual(await profileRunning(p, { live: async () => undefined, holder, alive: () => true, holds: () => 'unknown' }), { held: 86861 })
  assert.equal(await profileRunning(p, { live: async () => undefined, holder, alive: () => true, holds: () => 'no' }), undefined, 'a copied lock')
  assert.equal(await profileRunning(p, { live: async () => undefined, holder, alive: () => false }), undefined, 'a dead holder')
  assert.equal(await profileRunning(p, { live: async () => undefined, holder: () => undefined }), undefined)
  assert.match(listLine({ name: 'sso', protected: true, source: { kind: 'external', from: '/u' }, proxy: {} }, { held: 86861 }),
    /running: held by pid 86861 \(a browser outside this registry\)$/)
  const w = world()
  try {
    createProfile('ghe', { clone: 'sso' }, w.ctx)
    await assert.rejects(profileCommand(['refresh', 'ghe'], { running: async () => ({ held: 1 }) }, w.ctx), /is running/)
  } finally {
    w.done()
  }
})
