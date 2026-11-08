---
title: Browser Use tools
created: 2026-10-29T00:39:44Z
modified: 2026-10-29T00:39:44Z
version: 1.0.0
description: The browser tool's own _tools_ type folder, holding the helpers its checks run on.
grounded_in:
  - source: heddle commit a4c9726, _tools_/verify-runner run.mjs and lib.mjs (github.com/dtadpole/heddle), carried into reflection on 2026-10-28
---

# `_tools_`

Helpers the browser tool's checks run on, kept beside the tool rather than in a shared tree.

| Instance | What it is |
|---|---|
| [`verify-runner/`](verify-runner/INDEX.md) | the verdict runner and fixture helpers the [verifiers](../_verifiers_/INDEX.md) use |
