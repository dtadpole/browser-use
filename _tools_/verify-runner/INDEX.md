---
title: Browser Use verify runner
created: 2026-10-29T00:39:44Z
modified: 2026-10-29T00:39:44Z
version: 1.0.0
description: The runner that gives the browser tool's verifiers their 0, 1 and 3 verdicts, and the three fixture helpers their checks import.
grounded_in:
  - source: heddle commit a4c9726, _tools_/verify-runner run.mjs and lib.mjs (github.com/dtadpole/heddle), carried into reflection on 2026-10-28
---

# `verify-runner`

Instance of [`_tools_`](../INDEX.md), carried from heddle's `_tools_/verify-runner/` (`a4c9726`) so
the verifiers run without heddle.

| File | What it is |
|---|---|
| [`run.mjs`](run.mjs) | runs one check file and maps it to the verdict contract: `0` holds, `1` fails, `3` could not be judged; copied unchanged |
| [`lib.mjs`](lib.mjs) | `fixtureDir`, `removeDir`, `skipUnless`; only these three were taken, and fixtures go under `~/.browser-use/verify/` (`BROWSER_USE_SCRATCH` moves them), never the checkout, on a path short enough for the session check's Unix socket (macOS caps it at 104 bytes) |

Each `verify.sh` calls `run.mjs` per check file. The helpers are tested in
[`verifier-lib.test.mjs`](../../_tests_/component-rules/verifier-lib.test.mjs).
