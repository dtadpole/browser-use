import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { clearSingleton, processAlive, singletonHolder } from '../../chrome.mjs'
import { acquireStartLock, START_LOCK } from '../../client.mjs'

/**
 * One start per state directory, and a live browser's profile locks left alone (Review A on PR #572, A-M1: two first
 * calls on one state directory each started a host, and the second removed the first browser's SingletonLock).
 */

const scratch = () => mkdtempSync(join(tmpdir(), 'bu-lock-'))
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid // exited by the time spawnSync returns

test('processAlive: this process and another user\'s yes; a finished child, zero and junk no', () => {
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(1), true, 'pid 1 belongs to root: EPERM still means alive')
  assert.equal(processAlive(deadPid()), false)
  for (const pid of [0, -1, Number.NaN, 1.5, undefined]) assert.equal(processAlive(pid), false, String(pid))
})

test('singletonHolder reads <hostname>-<pid> and names a foreign or unreadable holder', () => {
  const dir = scratch()
  try {
    assert.equal(singletonHolder(dir, 'me'), undefined)
    symlinkSync('me.local-4242', join(dir, 'SingletonLock'))
    assert.deepEqual(singletonHolder(dir, 'me.local'), { host: 'me.local', pid: 4242, foreign: false })
    assert.equal(singletonHolder(dir, 'other').foreign, true)
    rmSync(join(dir, 'SingletonLock'))
    symlinkSync('no-pid-here', join(dir, 'SingletonLock'))
    assert.deepEqual(singletonHolder(dir, 'no-pid'), { host: 'no-pid-here', pid: undefined, foreign: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clearSingleton removes a dead browser\'s locks and keeps a live or foreign one\'s', () => {
  const dir = scratch()
  const make = (target) => {
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(dir, name), { force: true })
    symlinkSync(target, join(dir, 'SingletonLock'))
    writeFileSync(join(dir, 'SingletonCookie'), 'x')
  }
  try {
    const mine = () => `chrome --user-data-dir=${dir} --no-first-run`
    make(`h-${process.pid}`)
    assert.equal(clearSingleton(dir, processAlive, 'h', mine), false)
    assert.equal(existsSync(join(dir, 'SingletonCookie')), true, 'a live holder keeps its files')
    // Review B on PR 2133, B-I1: a lock copied with the profile names another profile's live browser - cleared
    assert.equal(clearSingleton(dir, processAlive, 'h', () => 'chrome --user-data-dir=/elsewhere/chrome-profile'), true)
    assert.equal(existsSync(join(dir, 'SingletonCookie')), false, 'a copied lock is removed from the copy')
    make(`h-${process.pid}`)
    assert.equal(clearSingleton(dir, processAlive, 'h', () => undefined), false, 'an unreadable command line keeps them')
    make('elsewhere-1')
    assert.equal(clearSingleton(dir, () => false, 'h'), false, 'another machine\'s lock is never removed')
    make(`h-${deadPid()}`)
    assert.equal(clearSingleton(dir, processAlive, 'h'), true)
    assert.equal(existsSync(join(dir, 'SingletonCookie')), false)
    assert.equal(clearSingleton(dir, processAlive, 'h'), true, 'no lock at all: nothing to keep')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the start lock: one taker, waiters time out, a dead or empty-and-old holder is replaced', { timeout: 10_000 }, async () => {
  const dir = scratch()
  const path = join(dir, START_LOCK)
  try {
    const release = await acquireStartLock(dir, { pid: 111, alive: () => true })
    assert.equal(readFileSync(path, 'utf8'), '111')
    const started = Date.now()
    assert.equal(await acquireStartLock(dir, { pid: 222, alive: () => true, timeoutMs: 250, pollMs: 50 }), undefined)
    assert.ok(Date.now() - started >= 250, 'a waiter waits for the timeout')
    const takeover = await acquireStartLock(dir, { pid: 333, alive: (p) => p !== 111, timeoutMs: 250 })
    assert.equal(readFileSync(path, 'utf8'), '333', 'a dead holder is replaced')
    release() // 111's release must not remove 333's lock
    assert.equal(readFileSync(path, 'utf8'), '333')
    takeover()
    assert.equal(existsSync(path), false)
    writeFileSync(path, '')
    assert.equal(await acquireStartLock(dir, { pid: 444, timeoutMs: 150, pollMs: 50 }), undefined, 'a fresh empty lock is being written')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(path, old, old)
    const fromEmpty = await acquireStartLock(dir, { pid: 555, timeoutMs: 150 })
    assert.equal(readFileSync(path, 'utf8'), '555', 'an empty lock older than ten seconds is stale')
    fromEmpty()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a waiter takes the lock as soon as it is released', { timeout: 10_000 }, async () => {
  const dir = scratch()
  try {
    const release = await acquireStartLock(dir, { pid: 1, alive: () => true })
    setTimeout(release, 120)
    const second = await acquireStartLock(dir, { pid: 2, alive: () => true, timeoutMs: 2_000, pollMs: 30 })
    assert.equal(typeof second, 'function')
    assert.equal(readFileSync(join(dir, START_LOCK), 'utf8'), '2')
    second()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a host record is removed only when its process is gone', async () => {
  const { recordIsStale } = await import('../../client.mjs')
  assert.equal(recordIsStale(undefined), true)
  assert.equal(recordIsStale({ socket: '/x' }), true, 'no pid')
  assert.equal(recordIsStale({ pid: deadPid() }), true)
  assert.equal(recordIsStale({ pid: process.pid }), false, 'a live host that did not answer is never replaced')
  assert.equal(recordIsStale({ pid: 7 }, () => false), true)
})

/** A stand-in for `cli.mjs __daemon`: records its start, starts slowly, then answers every request like a host. */
const FAKE_DAEMON = (socketName, stateName) => `
import fs from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
const dir = process.argv.find((a) => a.startsWith('--state=')).slice('--state='.length)
fs.appendFileSync(join(dir, 'spawned.txt'), process.pid + '\\n')
await new Promise((r) => setTimeout(r, 400))
const sock = join(dir, ${JSON.stringify(socketName)})
fs.rmSync(sock, { force: true })
const server = net.createServer((s) => {
  let buf = ''
  s.setEncoding('utf8')
  s.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      s.write(JSON.stringify({ id: m.id, ok: true, result: { pid: process.pid, proxy: [] } }) + '\\n')
      if (m.tool === '__shutdown') {
        server.close()
        fs.rmSync(sock, { force: true })
        fs.rmSync(join(dir, ${JSON.stringify(stateName)}), { force: true })
        setTimeout(() => process.exit(0), 50)
      }
    }
  })
})
server.listen(sock, () => fs.writeFileSync(join(dir, ${JSON.stringify(stateName)}), JSON.stringify({ pid: process.pid, socket: sock, stateDir: dir })))
`

test('two concurrent first calls on one state directory start one host and both join it', { timeout: 30_000 }, async () => {
  const { ensureHost, stopHost } = await import('../../client.mjs')
  const { SESSION_SOCKET, SESSION_STATE } = await import('../../host.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'bu-race-'))
  const fake = join(dir, 'fake-daemon.mjs')
  writeFileSync(fake, FAKE_DAEMON(SESSION_SOCKET, SESSION_STATE))
  try {
    const [a, b] = await Promise.all([ensureHost({ stateDir: dir, cliPath: fake }), ensureHost({ stateDir: dir, cliPath: fake })])
    assert.equal(a.health.pid, b.health.pid)
    assert.equal(readFileSync(join(dir, 'spawned.txt'), 'utf8').trim().split('\n').length, 1, 'one host process was started')
    assert.equal(existsSync(join(dir, START_LOCK)), false, 'the lock is released')
    // a call asking for a proxy the live host was not started with is refused, not served without it
    await assert.rejects(ensureHost({ stateDir: dir, cliPath: fake, proxyPac: 'http://127.0.0.1:18085/site.pac' }),
      /is running with proxy \[none\], not \[--proxy-pac-url=http:\/\/127\.0\.0\.1:18085\/site\.pac\]; stop it first/)
    const again = await ensureHost({ stateDir: dir, cliPath: fake })
    assert.equal(again.health.pid, a.health.pid, 'a call without a proxy is served by the live host')
  } finally {
    await stopHost({ stateDir: dir })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('proxyMismatch: none asked is always served; the same flags are; others are refused', async () => {
  const { proxyMismatch } = await import('../../client.mjs')
  const pac = ['--proxy-pac-url=http://h/x.pac']
  assert.equal(proxyMismatch([], { proxy: pac }, '/d'), undefined)
  assert.equal(proxyMismatch(pac, { proxy: pac }, '/d'), undefined)
  assert.match(proxyMismatch(pac, { proxy: [] }, '/d'), /running with proxy \[none\]/)
  assert.match(proxyMismatch(pac, {}, '/d'), /running with proxy \[none\]/, 'a host from before this change reports no proxy')
  assert.match(proxyMismatch(pac, { proxy: ['--proxy-server=h:1'] }, '/d'), /running with proxy \[--proxy-server=h:1\]/)
})

test('a stale lock is taken over atomically: a fresh lock moved by a late waiter goes back (Review A on PR #582, A-M2)', async () => {
  const { takeOverStaleLock } = await import('../../client.mjs')
  const dir = scratch()
  const path = join(dir, START_LOCK)
  try {
    const dead = String(deadPid())
    writeFileSync(path, dead)
    assert.equal(takeOverStaleLock(path, dead, 1), true, 'the judged stale lock is removed')
    assert.equal(existsSync(path), false)
    assert.equal(takeOverStaleLock(path, dead, 2), false, 'a second waiter finds nothing to move and retries')
    // the race: waiter 1 judged the dead lock stale, waiter 2 took it over and created its own; waiter 1's takeover
    // now moves waiter 2's fresh lock - and must put it back
    writeFileSync(path, String(process.pid))
    assert.equal(takeOverStaleLock(path, dead, 3), false)
    assert.equal(readFileSync(path, 'utf8'), String(process.pid), 'the fresh lock is back in place')
    const { readdirSync } = await import('node:fs')
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.stale-')), [], 'no moved file is left behind')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two waiters on one dead lock: exactly one takes the start lock', { timeout: 10_000 }, async () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, START_LOCK), String(deadPid()))
    const results = await Promise.all([1, 2].map((n) =>
      acquireStartLock(dir, { timeoutMs: 400, pid: 900000 + n, alive: (p) => p > 900000, pollMs: 10 })))
    assert.equal(results.filter((r) => r !== undefined).length, 1, 'one holder; the other waited and timed out')
    results.find((r) => r !== undefined)()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a waiter joining a host just started with another proxy is refused (Review A on PR #582, A-M3)', { timeout: 30_000 }, async () => {
  const { startHostProcess, stopHost } = await import('../../client.mjs')
  const { SESSION_SOCKET, SESSION_STATE } = await import('../../host.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'bu-join-'))
  const fake = join(dir, 'fake-daemon.mjs')
  writeFileSync(fake, FAKE_DAEMON(SESSION_SOCKET, SESSION_STATE))
  try {
    const pac = 'http://127.0.0.1:18085/site.pac'
    const [first, second] = await Promise.allSettled([
      startHostProcess({ stateDir: dir, cliPath: fake }),
      new Promise((r) => setTimeout(r, 50)).then(() => startHostProcess({ stateDir: dir, cliPath: fake, proxyPac: pac })),
    ])
    assert.equal(first.status, 'fulfilled')
    assert.equal(second.status, 'rejected', 'served by the first browser, it would browse without its proxy')
    assert.match(String(second.reason), /is running with proxy \[none\], not \[--proxy-pac-url=/)
    assert.equal(readFileSync(join(dir, 'spawned.txt'), 'utf8').trim().split('\n').length, 1)
  } finally {
    await stopHost({ stateDir: dir })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the default profile lies under the session\'s state directory', async () => {
  const { defaultProfilePath, stateDir } = await import('../../chrome.mjs')
  const saved = { home: process.env.HEDDLE_BROWSER_HOME, session: process.env.HEDDLE_BROWSER_SESSION }
  try {
    process.env.HEDDLE_BROWSER_HOME = '/tmp/bu-home'
    process.env.HEDDLE_BROWSER_SESSION = 'GHE'
    assert.equal(stateDir(), '/tmp/bu-home/sessions/ghe')
    assert.equal(defaultProfilePath(), '/tmp/bu-home/sessions/ghe/chrome-profile', 'not /tmp/bu-home/chrome-profile')
    delete process.env.HEDDLE_BROWSER_SESSION
    assert.equal(defaultProfilePath(), '/tmp/bu-home/chrome-profile')
  } finally {
    for (const [key, name] of [['home', 'HEDDLE_BROWSER_HOME'], ['session', 'HEDDLE_BROWSER_SESSION']]) {
      if (saved[key] === undefined) delete process.env[name]
      else process.env[name] = saved[key]
    }
  }
})
