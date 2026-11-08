---
title: Browser Use coverage and checks
created: 2026-10-29T00:33:39Z
modified: 2026-10-29T00:33:39Z
version: 1.0.0
level: L1
status: unverified
description: Which of the 32 tools the DSH browser advertises the tool implements, and how component tests and delivery verifiers divide the checking.
grounded_in:
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
  - source: the DSH browser MCP surface as read on 2026-10-17, recorded in heddle _context_/dsh-browser-mcp
---

# Coverage and checks

The harness's browser advertised **32 tools** from `chrome-devtools-mcp`
([reading](https://github.com/dtadpole/heddle/tree/main/_context_/dsh-browser-mcp)). The tool
replicates the protocol-callable ones and names the rest.

| Group | State |
|---|---|
| pages, navigation, interaction, screenshot, script, console, network, emulation | implemented (24 tools) |
| `get_css_styles`, `take_heapsnapshot`, `screencast_start`/`stop`, `performance_start_trace`/`stop_trace` | implemented |
| `lighthouse_audit` | excluded: the Lighthouse engine, not a protocol call |
| `performance_analyze_insight` | excluded: the DevTools frontend's insight model, not a protocol call |

**30 of 32 implemented, 2 named as excluded**; `click_at` is implemented too. The component test
`every advertised DSH tool is implemented or named as excluded` fails if that stops being true.

## Two kinds of check

A static fact about the code (a list of names, a parser's output) is a **component test** in
[`_tests_/component-rules/`](_tests_/component-rules/INDEX.md): no browser, fast, deterministic. A fact
about a browser, a page or a command boundary is a **delivery claim** in
[`_verifiers_/`](_verifiers_/INDEX.md), judged `0` holds, `1` fails, `3` unjudged. Keeping them apart
stops a verifier certifying a delivery on a table lookup.

```bash
node --test _tests_/component-rules/*.test.mjs     # no browser
_verifiers_/browser-surface/verify.sh              # headless
_verifiers_/browser-session/verify.sh              # headless
```

Each verifier serves its own fixture page on loopback, so a run spends nothing and needs no network.
