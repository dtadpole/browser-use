---
title: Browser Use tests
created: 2026-10-29T00:37:47Z
modified: 2026-10-29T00:37:47Z
version: 1.0.0
description: The browser tool's own _tests_ type folder, holding its component suites beside the code they judge.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, keeping the browser tool's tests under the tool rather than in a global tree
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
---

# `_tests_`

The browser tool's component suites, kept **inside the tool they judge**: a test's imports are two
levels up, and a change to the tool and its tests is one folder's worth of diff.

| Instance | The suite |
|---|---|
| [`component-rules/`](component-rules/INDEX.md) | the rules the helpers implement (frame codec, keys, viewport syntax, snapshot text, pagination, the tool table, the state directory) and the verifier helpers |

```bash
node --test _tests_/component-rules/*.test.mjs
```

No browser, no server and no build. Delivered behaviour is judged in [`_verifiers_/`](../_verifiers_/INDEX.md)
instead.
