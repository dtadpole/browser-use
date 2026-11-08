---
title: Verifier Browser Surface claims
created: 2026-10-29T00:37:32Z
modified: 2026-10-29T00:37:32Z
version: 1.0.0
level: L1
status: unverified
description: The numbered claims the browser-surface verifier decides, each with why it is not obvious.
grounded_in:
  - source: heddle commit 619b8c1, _tools_/browser-use/_verifiers/browser-surface/INDEX.md (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
---

# `browser-surface` claims

| # | Claim | Why it is not obvious |
|---|---|---|
| 1 | a snapshot names the page and its elements | the tree is the interface; a uid that names nothing is worse than no uid |
| 2 | a click hits the element the uid named, after scrolling it into view | `element.click()` passes a page that listens for real pointer events; a scripted check would not see the difference |
| 3 | fill reaches a framework's state | assigning `value` leaves React's state stale; the prototype setter plus `input`/`change` is what a keyboard does |
| 4 | typing and keys reach a key listener | a value that appears without the events is not typing |
| 5 | hover and drag move a real mouse | a synthetic event carries no coordinates for a pointer the browser is not tracking |
| 6 | a file input receives files | only the protocol's own `DOM.setFileInputFiles` does this |
| 7 | a dialog blocks the tools that must not run through it, until it is answered | a click that opens a `confirm` leaves a call unanswered; the tool must not deadlock on itself |
| 8 | the console and the network are readable, one message and one request at a time | the two things a page's own behaviour is judged by |
| 9 | screenshots are real images, of the viewport, the page, and one element | a blank image passes a size check but not this one |
| 10 | navigation reaches URL, back, forward and reload, and the old uids die with the document | clicking a lookalike element from the previous page is the silent failure |
| 11 | emulation changes what the page believes, and a second call replaces rather than adds | `matchMedia` and `innerWidth` are the page's own reading |
| 12 | the last page cannot be closed | the tool keeps the one page it needs |
