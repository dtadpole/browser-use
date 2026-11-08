---
title: Browser Use modules
created: 2026-10-29T00:33:22Z
modified: 2026-10-30T13:43:00Z
version: 1.1.0
level: L1
status: unverified
description: What each module of the browser tool owns, from the protocol client to the command line.
grounded_in:
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
---

# Modules

| File | Owns |
|---|---|
| [`cdp.mjs`](cdp.mjs) | the WebSocket client and the protocol envelope: fragmented frames, pings, error replies, sessions |
| [`chrome.mjs`](chrome.mjs) | finding, starting and stopping Chrome; the profile it keeps; the no-sandbox retry |
| [`page.mjs`](page.mjs) | one page: navigation, execution contexts, dialogs, console and network collection, screenshots |
| [`browser.mjs`](browser.mjs) | the browser and its pages, attached flattening, page ids and browser contexts |
| [`snapshot.mjs`](snapshot.mjs) | the accessibility snapshot, the uid contract and its text form |
| [`actions.mjs`](actions.mjs) | click, fill, type, press, hover, drag, upload, dialogs, script evaluation |
| [`emulate.mjs`](emulate.mjs) | viewport, colour scheme, media features, network conditions, geolocation, CPU throttling |
| [`format.mjs`](format.mjs) | the text forms: pages, console messages, network requests, pagination |
| [`tools.mjs`](tools.mjs) | the tool table, one handler per tool, shared by the command line and the host |
| [`host.mjs`](host.mjs) | the session host: one browser, one Unix socket, commands serialized |
| [`client.mjs`](client.mjs) | the command side: is a host alive, start one, call a tool, stop it |
| [`profiles.mjs`](profiles.mjs) | the profile registry: profile.json, copies, protection, the settings a start applies |
| [`profile-cli.mjs`](profile-cli.mjs) | the `profile` command and a selected profile's start options |
| [`lib.mjs`](lib.mjs) | the library face, including the one-page API checks use |
| [`cli.mjs`](cli.mjs) | the command line |

`openPage()` is the one-browser-one-page shape the verifiers use; `openBrowser()` plus
`createTools()` is the session shape the command line uses. Both run the same driver, so a check that
passes through `openPage` has exercised what the command line runs.
