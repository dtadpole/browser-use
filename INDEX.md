---
title: Browser Use
created: 2026-10-29T00:33:22Z
modified: 2026-11-09T06:02:25Z
version: 2.1.0
description: A dependency-free browser an agent or a check drives over the Chrome DevTools protocol, with the harness browser's tool surface and one long-lived session behind its command line.
grounded_in:
  - source: owner request 2026-11-08, moving browser-use out of reflection into its own public repository github.com/dtadpole/browser-use
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), where it began
---

# `browser-use`

**What it offers: profiles, sessions, tools.** A **profile** is who the browser is and how it reaches the network:
its logins and cookies, extension policy, proxy and headed default (`cli.mjs profile list`). A **session** is the one
running browser of a profile. **Tools** act on a session's pages. Every command runs on a named profile, `default`
when none is named.

A browser that a session, a person or a check can drive: a Chrome DevTools Protocol client written on `node:net`, the
tool surface of the harness's own browser (`take_snapshot` with uids, `click`, `fill`, console, network, screenshots,
emulation), and a command line that keeps one browser alive between commands. It needs Chrome and Node, nothing from
npm.

```bash
node cli.mjs new_page '{"url": "https://example.com"}'
node cli.mjs take_snapshot
node cli.mjs --profile=site open some/repository
```

The last line opens a site that answers only through a proxy; the profile's start verifies the route
([a site behind a proxy](proxied-site.md)).

**Provenance.** Begun as heddle's `_tools_/browser-use/` (commit `619b8c1`); grown in the owner's reflection
repository from 2026-10-28 to 2026-11-08 (profiles, the proxy extension policy, the route check, `open` and
`proxy-check`); its own repository since 2026-11-08, with a fresh history. The `HEDDLE_BROWSER_*` variables keep
their names.

| Read | For |
|---|---|
| [usage](usage.md) | running it, profiles (create, select, refresh, protect), sessions, a proxy |
| [a site behind a proxy](proxied-site.md) | one command, what a start verifies, `proxy-check` |
| [modules](modules.md) | what each file owns |
| [decisions](decisions.md) | the choices worth knowing |
| [coverage](coverage.md) | the DSH surface it replicates, and how it is checked |
| [`_tests_/`](_tests_/INDEX.md), [`_verifiers_/`](_verifiers_/INDEX.md), [`_tools_/`](_tools_/INDEX.md) | component suites; delivery claims; the verifier runner |
