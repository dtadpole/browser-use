import assert from 'node:assert/strict'
import { test } from 'node:test'

import { proxyArgs } from '../../chrome.mjs'
import { daemonArgs } from '../../client.mjs'

/**
 * The proxy rule (owner request 2026-10-29: open the GHE web page through http://127.0.0.1:18085/site.pac in
 * browser-use's own browser, never through the owner's Chrome or the system proxy): which Chrome flag a start gets
 * from `proxyPac` / `proxyServer` or HEDDLE_BROWSER_PROXY_PAC / HEDDLE_BROWSER_PROXY_SERVER, and what is refused.
 */

const PAC = 'http://127.0.0.1:18085/site.pac'
const env = (pac, server) => ({
  ...(pac !== undefined ? { HEDDLE_BROWSER_PROXY_PAC: pac } : {}),
  ...(server !== undefined ? { HEDDLE_BROWSER_PROXY_SERVER: server } : {}),
})

test('with neither setting the browser gets no proxy flag', () => {
  assert.deepEqual(proxyArgs({}, {}), [])
  assert.deepEqual(proxyArgs({}, env('', '   ')), [], 'an empty or blank value counts as unset')
})

test('a PAC alone becomes --proxy-pac-url', () => {
  assert.deepEqual(proxyArgs({}, env(PAC)), [`--proxy-pac-url=${PAC}`])
  assert.deepEqual(proxyArgs({}, env(` ${PAC} `)), [`--proxy-pac-url=${PAC}`], 'surrounding blanks are trimmed')
  assert.deepEqual(proxyArgs({}, env('https://proxy.example/x.pac')), ['--proxy-pac-url=https://proxy.example/x.pac'])
})

test('a server alone becomes --proxy-server', () => {
  for (const server of ['127.0.0.1:18080', 'http://127.0.0.1:18080', 'socks5://localhost:1080', '[::1]:8080',
    'proxy.example', 'http=a.example:80;https=b.example:443', 'direct://']) {
    assert.deepEqual(proxyArgs({}, env(undefined, server)), [`--proxy-server=${server}`], server)
  }
})

test('with both set the PAC wins and the server is not passed', () => {
  assert.deepEqual(proxyArgs({}, env(PAC, '127.0.0.1:18080')), [`--proxy-pac-url=${PAC}`])
  assert.deepEqual(proxyArgs({ proxyServer: '127.0.0.1:1' }, env(PAC)), [`--proxy-pac-url=${PAC}`])
})

test('an option wins over its variable', () => {
  assert.deepEqual(proxyArgs({ proxyPac: 'http://localhost:1/a.pac' }, env(PAC)), ['--proxy-pac-url=http://localhost:1/a.pac'])
  assert.deepEqual(proxyArgs({ proxyServer: 'h:2' }, env(undefined, 'h:1')), ['--proxy-server=h:2'])
})

test('a PAC that is not an http: or https: URL is refused, never passed', () => {
  for (const pac of ['file:///Users/x/site.pac', 'ftp://h/x.pac', 'data:text/plain,x', 'not a url', '127.0.0.1:18085/site.pac']) {
    assert.throws(() => proxyArgs({}, env(pac)), /the proxy PAC .* (is not a URL|must be an http: or https: URL)/, pac)
  }
})

test('a server that is not [scheme://]host[:port] is refused', () => {
  for (const server of ['a b:1', 'host:0', 'host:70000', 'http://', 'ftp://h:21', 'h:1;', 'h:port', '-bad:1']) {
    assert.throws(() => proxyArgs({}, env(undefined, server)), /the proxy server .* is not \[scheme:\/\/\]host\[:port\]/, server)
  }
})

test('the start options reach the session host as flags', () => {
  const args = daemonArgs({ proxyPac: PAC, proxyServer: 'h:1', headless: true }, '/tmp/state')
  assert.deepEqual(args.slice(1), ['__daemon', '--state=/tmp/state', '--headless', `--proxy-pac=${PAC}`, '--proxy-server=h:1'])
  assert.deepEqual(daemonArgs({ proxyPac: '' }, '/tmp/state').slice(1), ['__daemon', '--state=/tmp/state'])
})
