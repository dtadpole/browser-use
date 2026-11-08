import assert from 'node:assert/strict'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fixtureDir, removeDir, scratchRoot, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

const checkout = fileURLToPath(new URL('../../', import.meta.url))

test('fixtures live outside the checkout, under the scratch root', () => {
  const dir = fixtureDir('probe')
  try {
    assert.ok(dir.startsWith(scratchRoot), 'a fixture is under the scratch root')
    assert.ok(!dir.startsWith(checkout), 'a fixture never sits inside the checkout')
  } finally {
    removeDir(dir)
  }
})

test('a fixture leaves room for the session socket under the macOS 104-byte limit', () => {
  // Measured 2026-10-28: with fixtures under os.tmpdir() (/var/folders/.../T/) the browser-session host's
  // socket path was 111 bytes and listen() failed with EINVAL; sun_path holds 104 bytes including the NUL.
  const dir = fixtureDir('browser-session-00000-abcdef')
  try {
    const socket = join(dir, 'session.sock')
    assert.ok(Buffer.byteLength(socket) <= 103, `socket path is ${Buffer.byteLength(socket)} bytes: ${socket}`)
  } finally {
    removeDir(dir)
  }
})

test('each fixture is fresh, empty and distinct', () => {
  const a = fixtureDir('same-label')
  const b = fixtureDir('same-label')
  try {
    assert.notEqual(a, b, 'two calls with one label give two directories')
    assert.deepEqual(readdirSync(a), [], 'a new fixture is empty')
    writeFileSync(join(a, 'left-over'), 'x')
    assert.equal(existsSync(join(b, 'left-over')), false, 'fixtures do not share files')
  } finally {
    removeDir(a)
    removeDir(b)
  }
})

test('removeDir removes a tree and tolerates an absent path', () => {
  const dir = fixtureDir('remove')
  writeFileSync(join(dir, 'f'), 'x')
  removeDir(dir)
  assert.equal(existsSync(dir), false)
  assert.doesNotThrow(() => removeDir(dir), 'removing an absent directory is not an error')
})

test('skipUnless skips with the reason only when the condition fails', () => {
  const calls = []
  const context = { skip: (reason) => calls.push(reason) }
  assert.equal(skipUnless(context, true, 'unused'), true)
  assert.deepEqual(calls, [], 'a held condition does not skip')
  assert.equal(skipUnless(context, undefined, 'no browser on this machine'), false)
  assert.deepEqual(calls, ['no browser on this machine'], 'a failed condition skips with its reason')
})
