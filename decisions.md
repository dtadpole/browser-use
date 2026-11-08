---
title: Browser Use decisions
created: 2026-10-29T00:33:39Z
modified: 2026-11-08T04:02:47Z
version: 1.3.0
level: L1
status: unverified
description: The design choices of the browser tool that a caller should know before relying on it.
grounded_in:
  - source: 'owner request 2026-11-08 034xZ in session-8e72e151 (harden the proxy setup; REF #5608)'
  - source: 'owner request 2026-10-30 064x PDT via the [reflection] Coordinator, item 20261030T133505Z (profile management as a core part of browser-use and its mental model)'
  - source: heddle commit 619b8c1, _tools_/browser-use (github.com/dtadpole/heddle), ported to reflection on 2026-10-28
  - source: owner statement in the dsh session, 2026-10-17, asking for a browser tool that replicates the DSH browser MCP
---

# Decisions worth knowing

- **Profiles are first-class** (owner request, 2026-10-30). A profile (logins, extension policy, proxy, headed
  default) is what a person picks; a session is its one running browser. The registry is
  `<root>/profiles/<name>/` (`profile.json`, `chrome-profile/`, `session/`), or `~/.browser-use/browser/profiles/`
  when the root lies in the SSO home; `default` keeps the old layout so nothing moved. External profiles such as `sso` are protected references. `disable-proxy-controllers`
  disables only the extensions with the proxy permission, through `chrome.management` on chrome://extensions after the
  start, then checks that none is left enabled (2026-11-02: Chrome 156 kept Proxy Helper enabled under `--disable-extensions`,
  which the policy had relied on).

- **A session, not a launch per command.** Console messages and network requests exist only while
  someone listens, so a command that attached, acted and detached would see an empty history. A small
  detached host owns the connection; commands reach it over a Unix socket, one at a time.
- **A browser per session.** `--session=NAME` gives commands their own browser, profile and tabs, so
  two agents are two sessions rather than two writers of one `list_pages`. Inside one session,
  `new_page` with `isolatedContext` gives a clean-slate tab.
- **A proxy is judged by its route** (#5608). Flags and extension reports are claims: Proxy Helper loaded after the
  extension check and GHE went direct. A profile's `proxy_check` loads a URL at every proxied start and requires
  Chrome's reported remote address to be the named proxy; anything else stops the browser.
- **Headed by default.** Part of the point is that a person can watch and sign in once; the login
  persists in the profile. `start --headless` serves a machine with no seat.
- **The uid contract.** `take_snapshot` numbers the accessibility tree and `click`/`fill` resolve a
  uid to the node the snapshot read. Uids survive further snapshots of one document and die with a
  navigation. A stale uid is refused, never guessed.
- **An action is a person's action.** A click is a real mouse event at the element's centre after
  scrolling it into view; a fill goes through the input prototype's setter and fires `input` and
  `change`, because assigning `value` leaves a framework's state stale.
- **The no-sandbox retry.** Where an outer confinement forbids Chrome's sandbox, a second start uses
  `--no-sandbox` and `status` says so: silently weakening a browser would be wrong, failing on every
  confined machine useless.
- **State outside the checkout** (reflection's change). The profile holds logins and cookies, and the
  reflection checkout is shared by many writers with no ignore rule for it, so the default is
  `~/.browser-use/browser/`; verifier fixtures go under `~/.browser-use/verify/`, short enough for a Unix socket path (the system temporary directory was measured too long on macOS).
