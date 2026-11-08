---
title: Browser Use verifiers
created: 2026-10-29T00:37:32Z
modified: 2026-10-29T00:37:32Z
version: 1.0.0
description: The delivery claims the browser tool must keep, one folder each, kept beside the tool they judge.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, asking for the browser tool's verifiers to live beside it
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
---

# `_verifiers_`

The tool's own `_verifiers_`: one kebab-case folder per claim, each a thin `verify.sh` over its check
files. They keep the verdict contract (`0` holds, `1` fails, `3` could not be judged) through
[`verify-runner`](../_tools_/verify-runner/INDEX.md), carried from heddle with its three fixture helpers; fixtures go under `~/.browser-use/verify/`, never the checkout.

| # | Folder | The claim | Surface |
|---|---|---|---|
| 1 | [`browser-surface/`](browser-surface/INDEX.md) | every page tool acts on the element a snapshot named, and a dialog or a navigation does not silently change what that means | headless by default; `HEDDLE_BROWSER_HEADED=1` also judges the window |
| 2 | [`browser-session/`](browser-session/INDEX.md) | one session survives between commands, and `status` and `stop` tell the truth about it | headless |

These are **delivery claims**: they drive a real browser or the command line. A rule about one
component belongs in [`_tests_/`](../_tests_/INDEX.md), where it runs without a browser; a verifier that
could pass on a table lookup is judging a component, not a delivery. Each index states its surface
because a check needing a window cannot run unattended, and one that does not should not take the focus.
