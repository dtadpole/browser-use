---
title: AGENTS.md
created: 2026-11-08T05:41:27Z
modified: 2026-11-08T05:41:27Z
version: 1.0.0
description: The entry point for whoever works in this repository - what it is, the conventions it follows, and how a change is checked.
grounded_in:
  - source: owner request 2026-11-08, moving browser-use into its own public repository
---

# AGENTS.md

The harness loads this file when a session runs here. It says what this repository is, which conventions it follows
and how to check that a change is finished.

## What this repository is

`browser-use` is a Chrome DevTools Protocol browser for agents and checks, with profiles, one long-lived session per
profile and the harness browser's tool surface. Its entry point is [`INDEX.md`](INDEX.md); [`README.md`](README.md)
is for a reader arriving cold.

## The conventions it follows

It follows the owner's `reflection` conventions, as `heddle` does:

- **Entry points.** Every content folder carries an `INDEX.md` saying what it is, what belongs in it and what to read
  next.
- **Type and instance trees.** `_tests_/`, `_verifiers_/` and `_tools_/` are type folders whose children are
  kebab-case instances.
- **Frontmatter.** Every markdown artifact carries YAML frontmatter (`title`, `created`, `modified`, `version`,
  `description`, `grounded_in`); articles add `level` and `status`; a value never holds an unquoted colon.
- **Concision.** An `INDEX.md` stays under 300 words, any other document under 500.
- **Tests for key functions.** A function with a rule in it gets a test that can fail.
- **Commits.** Conventional subjects (`fix(scope): ...`), one purpose per commit; work in a worktree and land through
  a pull request.
- **Public.** This repository is public: no credentials, no internal hostnames, company names or personal data -
  examples use `example.com`. Owner inputs and action logs live in the owner's private bank, not here.

## How a change is checked

```bash
node --test _tests_/component-rules/*.test.mjs        # no browser
_verifiers_/browser-surface/verify.sh                  # headless Chrome
_verifiers_/browser-session/verify.sh                  # headless Chrome
```

Run the component suite with the real node binary and a scratch home when it must not touch your profiles:
`HOME=/tmp/scratch "$(node -p process.execPath)" --test ...`.
