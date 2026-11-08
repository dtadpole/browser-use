---
title: browser-use
created: 2026-11-08T05:41:27Z
modified: 2026-11-08T05:41:27Z
version: 2.0.0
description: What browser-use is and how to start, for a reader arriving cold.
level: L1
status: unverified
grounded_in:
  - source: owner request 2026-11-08, moving browser-use into its own public repository
---

# browser-use

A dependency-free browser for agents and checks: a Chrome DevTools Protocol client written on `node:net`, the tool
surface of a coding harness's own browser (`take_snapshot` with uids, `click`, `fill`, console, network, screenshots,
emulation, traces), and a command line that keeps one browser alive between commands. It needs Chrome and Node 24,
nothing from npm.

```bash
git clone https://github.com/dtadpole/browser-use && cd browser-use
node cli.mjs new_page '{"url": "https://example.com"}'
node cli.mjs take_snapshot
node cli.mjs click '{"uid": "1_3"}'
node cli.mjs stop
```

- **Profiles.** A profile is who the browser is (logins, cookies, extensions) and how it reaches the network (a PAC or
  a proxy server). `node cli.mjs profile list | create | set | refresh`. A copy of a signed-in profile keeps the login
  while leaving the original untouched.
- **Sessions.** `--session=NAME` gives an agent a browser of its own, so two agents never share a selected page.
- **A site behind a proxy.** A profile can carry a route check: every start loads a URL and requires that it came back
  through the named proxy, or it stops the browser and says what answered. `node cli.mjs --profile=NAME
  proxy-check` diagnoses a running browser. See [`proxied-site.md`](proxied-site.md).
- **As a library.** `openPage()` and `openBrowser()` from [`lib.mjs`](lib.mjs) give a check a temporary profile.

State lives in `~/.browser-use/browser/` (`HEDDLE_BROWSER_HOME` moves it), never in the checkout.

```bash
node --test _tests_/component-rules/*.test.mjs   # the component suite, no browser
_verifiers_/browser-surface/verify.sh             # the tool surface against headless Chrome
```

Read [`INDEX.md`](INDEX.md) for the map of the repository and [`usage.md`](usage.md) for the details. MIT licensed.
Begun in [heddle](https://github.com/dtadpole/heddle).
