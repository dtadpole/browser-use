---
title: Browser Use usage
created: 2026-10-29T00:33:22Z
modified: 2026-11-08T04:02:47Z
version: 1.5.0
level: L1
status: unverified
description: How to run the browser tool, the three ways it is used, where its state lives and how two agents share a machine.
grounded_in:
  - source: 'owner request 2026-11-08 034xZ in session-8e72e151 (harden the proxy setup, make it an obvious option; REF #5608)'
  - source: 'owner request 2026-10-30 064x PDT via the [reflection] Coordinator, item 20261030T133505Z (profile management as a core part of browser-use and its mental model)'
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
  - source: owner request 2026-10-29 via session-3472cba8 (open the GHE web page through a proxy, never the owner's Chrome or the system proxy)
---

# Using `browser-use`

```bash
node cli.mjs start            # a visible browser, kept for later commands
node cli.mjs new_page '{"url": "https://example.com"}'
node cli.mjs take_snapshot
node cli.mjs click '{"uid": "1_3"}'
node cli.mjs take_screenshot '{"fullPage": true}'
node cli.mjs stop
```

Any tool call starts the session when none runs (one start at a time per session); `start` only matters when the
first call should be watched. Arguments are one JSON object or `--name=value` pairs; `cli.mjs tools` lists the
surface; `cli.mjs status` says what is running.

## Three ways in

| Who | How |
|---|---|
| a check | `openPage()` or `openBrowser()` from [`lib.mjs`](lib.mjs): a temporary profile per call, headless by default |
| a person | the command line, headed by default, one browser kept between commands |
| an agent | the same command line through the shell; it is repository tooling, not a registered harness tool |

## State and the signed-in profile

The profile persists, so a login done once in the visible window is reused. It lives in
`~/.browser-use/browser/`; `HEDDLE_BROWSER_HOME` moves it. A hand-made SSO login lives in `~/.heddle-browser` (the
built-in `sso` profile below): use a copy, never delete it.
`HEDDLE_BROWSER=/path/to/chrome` names a browser outside the usual locations.

## Watching, and two agents at once

The command line is headed by default; `start --headless` suits a machine with no seat, and
`HEDDLE_BROWSER_HEADED=1` makes a check visible.
Give each agent a session, `--session=NAME` or `HEDDLE_BROWSER_SESSION=NAME`: each gets its own
browser, profile and tabs, so neither can name the other's pages.

## A proxy, and a site behind it

`HEDDLE_BROWSER_PROXY_PAC` or `start --proxy-pac=` (http/https URL) passes `--proxy-pac-url`;
`HEDDLE_BROWSER_PROXY_SERVER` or `--proxy-server=` passes `--proxy-server`; with both, the PAC wins. A bad value fails
the start; a session running with another proxy refuses the call. A site behind a proxy is [one command](proxied-site.md).

Proxy Helper, in the SSO profile, outranks a PAC even under `--disable-extensions`. With
`extensions=disable-proxy-controllers` (`ghe` below) a proxied start waits for extensions to settle, disables the
proxy-permission ones and looks again; one left stops it; with `keep` it fails, naming it. A held profile fails too.
A profile's `proxy_check` (URL, proxy `host:port`) is the verdict: a start whose URL came back otherwise stops.

## Profiles

A profile is a login plus how it reaches the network. `profile list` shows each one's source (where its login comes
from), proxy, extension policy and whether it runs. `default` is the profile above; `sso` is a **protected**
reference to `~/.heddle-browser/chrome-profile`: `set`, `refresh`, `remove` and disabling extensions are refused, but
a start runs Chrome on it, which writes there. Automated work uses the copy `ghe`.

```bash
node cli.mjs profile create ghe --clone=sso --proxy-pac=http://127.0.0.1:18085/site.pac \
  --extensions=disable-proxy-controllers --proxy-check-url=https://git.example.com/ \
  --proxy-check-via=127.0.0.1:18080 --description="the company git server"
node cli.mjs --profile=ghe open some/repository
node cli.mjs profile refresh ghe   # re-copy the SSO login (Proxy Helper comes back enabled)
```

A copy leaves out locks and caches; a live source may be copied. A profile's settings apply at start; a start flag
or `HEDDLE_BROWSER_PROXY_*` overrides them with a notice. `--profile=NAME` names a profile; a directory needs a `/`, `~` or `.`
(`--profile=./mydir`), the older form. `profile add NAME --external=PATH` registers another protected profile.
