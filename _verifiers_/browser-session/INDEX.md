---
title: Verifier — Browser Session
created: 2026-10-29T00:37:32Z
modified: 2026-10-29T00:37:32Z
version: 1.0.0
description: one browser session survives between command lines, and status and stop tell the truth about it.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, asking for a browser tool with the harness browser's session behaviour
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
---

# `browser-session`

Instance of the tool's [`_verifiers_`](../INDEX.md). **The claim it decides:** the command line is a *session*, not a
launch per command — the browser the first command starts is the one the next command acts on, its
console and network history survive the boundary, `status` reports it truthfully, and `stop` ends it.

## Surface

**Headless.** Every command in this verifier runs against a headless browser with a state directory of
its own, because the claim is about the session rather than about the window; a run that opened a window
would take the machine's focus and could not run unattended.

## What it must get right

The numbered claims, each with why it is not obvious, are in [claims](claims.md).

## What it deliberately does not judge

- **The page tools themselves.** [`browser-surface/`](../browser-surface/INDEX.md) does that, in one
  process, with one browser.
- **The window.** Headless is this verifier's surface, and a session check should not need a seat.
- **A login done by hand.** The profile is persistent, but signing in is a person's act and nothing here
  pretends to judge it.

## How it is judged

```bash
./verify.sh
```

Every command is spawned against a state directory inside the check's own fixture, so this never touches
the browser profile of the machine's session host.
