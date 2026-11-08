---
title: Verifier — Browser Surface
created: 2026-10-29T00:37:32Z
modified: 2026-10-29T00:37:32Z
version: 1.0.0
description: every page tool acts on the element a snapshot named, and a dialog or a navigation does not silently change what that means.
grounded_in:
  - source: the tool surface recorded in heddle _context_/dsh-browser-mcp (github.com/dtadpole/heddle)
  - source: owner statement in the dsh session, 2026-10-17, asking for the tool to be verified against a real browser
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
---

# `browser-surface`

Instance of the tool's [`_verifiers_`](../INDEX.md). **The claim it decides:** the page tools — snapshot, click, fill,
fill_form, type, press, hover, drag, upload, dialogs, wait, evaluate, screenshot, pages, navigation,
console, network and emulation — each do what their name says on a real page, and the uid a snapshot
hands out is the element the next action hits.

## Surface

**Headless by default**, so it runs unattended on a machine with no seat and never takes the focus.
Run it headed to watch it work:

```bash
HEDDLE_BROWSER_HEADED=1 ./verify.sh
```

The headed run additionally judges the one claim a headless run cannot: that the browser really was a
visible window (`headless: false`), not a headless one pretending to be a browser. That check is a skip
— an **unjudged** verdict, never a pass — on a headless run.

## What it must get right

The numbered claims, each with why it is not obvious, are in [claims](claims.md).

## What it deliberately does not judge

- **The session between commands.** That is [`browser-session/`](../browser-session/INDEX.md).
- **Tools outside its claims.** The later tools (CSS styles, heap snapshots, screencasts, traces) are counted by the component coverage test; Lighthouse and insight analysis are excluded.
- **Whether the page's own product logic is right.** The fixture page is this check's own.

## How it is judged

```bash
./verify.sh
HEDDLE_BROWSER_HEADED=1 node --test check.mjs
```

The page is served by the check itself on loopback, so it spends nothing and needs no network. Every
behaviour is read back from the page's text, its console, or the network log — never from the tool's own
account of what it did.
