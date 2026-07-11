# 2026-07-11 — Bot commit guard

## Summary

Added an automated guard that enforces conventional commit format and subject
length for bot-authored commits, auto-fixing overlong headers and failing with
actionable diagnostics for non-fixable violations. Closes issue #137.

## Problem

A PR was blocked because a bot-authored commit subject exceeded the 120-char
`header-max-length` commitlint rule, requiring a manual `git commit --amend`.
The bug was caught at CI time rather than locally.

## Solution

Two complementary enforcement points:

1. **commit-msg hook** (`.githooks/commit-msg`) — fires for every `git commit`.
   Calls `scripts/agent/bot-commit-guard.mjs --fix-msg <file>`.
   - If the header is overlong but has a valid type: truncates at the last word
     boundary within the 120-char budget and appends `…`. Writes the fix
     back in-place so the commit proceeds transparently.
   - If the type is invalid or the format is wrong: exits 1 with a clear
     "Error / Fix / Suggestion" message.

2. **pre-push hook** (`.githooks/pre-push`) — safety-net for commits made with
   `--no-verify`. Calls `--check-push`, reads the push ref-pairs from stdin,
   inspects each range, and fails with per-commit diagnostics if any header
   violates the rules.

## Files touched

- `scripts/agent/bot-commit-guard.mjs` (new) — core guard logic, fully exported
  for unit-testing. Mirrors the ignore-rules and type list from
  `commitlint.config.cjs`.
- `scripts/agent/bot-commit-guard.test.mjs` (new) — 29 unit tests covering
  `isIgnored`, `parseHeader`, `truncateHeader`, `validateHeader`, `fixMsgFile`,
  and `checkPush`.
- `.githooks/commit-msg` (new) — commit-msg hook shell wrapper.
- `.githooks/pre-push` (updated) — appends `--check-push` safety-net call.
- `scripts/agent/setup-git-hooks.mjs` (updated) — registers the new
  `commit-msg` hook so `npm install` makes it executable.
- `package.json` (updated) — adds `scripts/agent/*.test.mjs` glob to
  `test:guards` so the new tests are covered by CI.

## Systems touched

ci, infra

## Verification

- `node --test scripts/agent/bot-commit-guard.test.mjs` → 29/29 pass.
- `npm run test:guards` → all new tests pass (12 pre-existing failures
  in sprite/set-piece extensions unaffected).
- `npm run lint -- scripts/agent/bot-commit-guard.mjs scripts/agent/bot-commit-guard.test.mjs` → clean.
- `npm run typecheck` → clean.
- Hook installed and executable via `node scripts/agent/setup-git-hooks.mjs`.

## Unresolved

None.

## Next steps

- If the `commit-msg` hook proves too aggressive for interactive contributors,
  consider an `--amend` workflow where the fix is applied silently.
- The `checkPush` function currently skips ranges for new branches when
  `origin/main` / `origin/master` are unreachable; a future improvement could
  fall back to scanning a fixed depth (e.g. `HEAD~10`).
