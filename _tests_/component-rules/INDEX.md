---
title: Browser Use component rules
created: 2026-10-29T00:37:47Z
modified: 2026-11-08T04:06:58Z
version: 1.2.0
description: The rules the browser tool's helpers implement, judged without a browser.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, separating component tests from delivery verifiers
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
---

# `component-rules`

Instance of [`_tests_`](../INDEX.md).

- [`unit.test.mjs`](unit.test.mjs): the frame codec, key names, viewport and geolocation syntax, the
  snapshot's text form, pagination, the console and network formatters, the session-directory rule, the
  default state directory (outside the checkout, added in reflection), and the coverage claim against the
  DSH advertised surface.
- [`verifier-lib.test.mjs`](verifier-lib.test.mjs): the verifier helpers in
  [`_tools_/verify-runner/lib.mjs`](../../_tools_/verify-runner/lib.mjs) (fresh, distinct fixtures outside the checkout;
  `removeDir`; `skipUnless`), added in reflection.
- [`proxy.test.mjs`](proxy.test.mjs): which proxy flag a start gets (PAC or server, option or variable; the PAC wins
  over a server) and the values refused, added in reflection on 2026-10-29.
- [`proxy-route.test.mjs`](proxy-route.test.mjs): a proxied start that would go direct (#5608, 2026-11-08) - the
  extension check settles and re-checks, the route check judges Chrome's remote address, a probe tab is really
  closed, `proxy_check` in profiles, `proxy-check` and `open`.

```bash
node --test _tests_/component-rules/*.test.mjs
```

With a scratch `HOME`, call the real node binary, never Volta's shim (`~/.volta/bin/node`): the shim finds its
toolchain through `HOME`, and without it re-runs itself without end. Resolve it first, `NODE=$(node -p
process.execPath)`, then `HOME=/tmp/scratch "$NODE" --test ...`; the tests' own children already use
`process.execPath`.

It does not judge what the tools do to a page (that is [`_verifiers_/`](../../_verifiers_/INDEX.md)),
and the coverage test asserts which tools exist, not that they work.
