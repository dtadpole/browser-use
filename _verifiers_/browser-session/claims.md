---
title: Verifier Browser Session claims
created: 2026-10-29T00:37:32Z
modified: 2026-10-29T00:37:32Z
version: 1.0.0
level: L1
status: unverified
description: The numbered claims the browser-session verifier decides, each with why it is not obvious.
grounded_in:
  - source: heddle commit 619b8c1, _tools_/browser-use/_verifiers/browser-session/INDEX.md (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
---

# `browser-session` claims

| # | Claim | Why it is not obvious |
|---|---|---|
| 1 | `start` opens a browser and records the session | a tool that starts nothing but says it did is indistinguishable from one that works |
| 2 | a later command finds the same session | a process per command would work for one action and lose every open tab, console message and request between actions |
| 3 | the console and the network survive the command boundary | they are events, and nothing replays them for a client that attaches afterwards |
| 4 | a screenshot is saved and named | a path that does not exist is a screenshot that was not taken |
| 5 | `stop` ends the session and clears its record | a stale state file makes the next start depend on a dead socket |
| 6 | a tool call starts a session when none is running | the first command should not need `start` first |
| 7 | the command line lists its tools and refuses an unknown one | the surface is discovered, not guessed |
| 8 | two named sessions have two browsers and two sets of tabs | two agents driving a browser at once must not fight over one selected page, and page ids from one session must not name a page in the other |
