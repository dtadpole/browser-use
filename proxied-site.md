---
title: A site reached only through a proxy
created: 2026-11-08T05:41:27Z
modified: 2026-11-08T05:41:27Z
version: 1.0.0
level: L1
status: unverified
description: How to open a site that answers only through a proxy with one command, what such a profile's start verifies, and how to diagnose a start that would go direct.
grounded_in:
  - source: 'measurements of 2026-11-08 in the owner''s session (a direct load answered 403 from the edge; proxied loads were reported from the local forward)'
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle)
---

# A site behind a proxy

Some sites answer only through a proxy: a company git server reached through a local forward, say. The example
here is `https://git.example.com/`, a local forward on `127.0.0.1:18080` and a PAC on `127.0.0.1:18085` that sends
only that host to the forward.

```bash
node cli.mjs profile create site --clone=sso --proxy-pac=http://127.0.0.1:18085/site.pac \
  --extensions=disable-proxy-controllers --proxy-check-url=https://git.example.com/ --proxy-check-via=127.0.0.1:18080
node cli.mjs --profile=site open some/repository   # starts the browser when none runs
node cli.mjs --profile=site proxy-check            # exit 1 names the problem; --fix disables proxy extensions
```

**What a start verifies.**

1. It waits until the extension list stops changing, disables every extension with the proxy permission, and looks
   again. A proxy extension's setting outranks `--proxy-pac-url`, and a sideloaded one can load after a one-look
   check.
2. It loads the `proxy_check` URL and requires Chrome's reported remote address to be the named proxy (loopback
   names count as one). A start that would go direct stops its browser and says what answered; `start` prints the
   route it saw.

**Diagnosis.** `proxy-check` lists the enabled proxy-controlling extensions and probes the route.

| You see | It means |
|---|---|
| `403` from the site's edge | the direct path: an extension or a DIRECT fallback won; `proxy-check --fix` |
| `ERR_PROXY_CONNECTION_FAILED`, no document | the forward is down |
| the check page did not load | the PAC server, or the forward behind it |
| the site's sign-in page | the route is right; the session is not signed in |

**Signing in** is a person's step, done once in the visible window. A copy of a signed-in profile can come up signed
out, so keep the browser running rather than restarting it.
