# Worktree node_modules auto-junction hook

**Date:** 2026-08-01
**Session:** nalfeo-stunning-invention
**Apple estimate:** 1🍎

## Summary

Added `.githooks/post-checkout` to automatically create a `node_modules`
junction/symlink in new worktrees at checkout time. Previously the Copilot app
created the junction reactively (when it detected the missing folder), leaving
a window where any command run before preflight would fail. The hook fires on
`git worktree add` and closes that gap entirely.

## Systems touched

tooling

## Files touched

- `.githooks/post-checkout` (new)
- `docs/knowledge/review-ledgers/2026-08-01-worktree-node-modules-hook.review-ledger.json` (new)

## Verification

- Confirmed current worktree had no `node_modules` before the change.
- Created directory junction manually for this session; verified it resolves to
  `Q:\src\crawler\node_modules` and that `node_modules/.bin/vite` is reachable.
- Hook marked executable (`100755`) in git index.
- Ledger validated: `npm run review:ledger -- validate` passes.

## Unresolved issues

None.

## Recommended next steps

None — the hook is self-contained. If the main checkout's `node_modules` is
ever absent when a worktree is created, the hook exits silently and the existing
preflight fallback still handles it.
