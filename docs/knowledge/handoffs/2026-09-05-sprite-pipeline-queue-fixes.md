# 2026-09-05 sprite pipeline queue fixes

## Systems touched

sprite-pipeline, sprite-workflow

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **2**

## Summary

Backported the low-risk generic sprite-pipeline and queue correctness fixes that were retained from PR #3234 into the current worktree, without touching the excluded generation/request workflow paths.

The patch preserves the existing pipeline behavior while removing two concrete regressions: repeated snapshot reads were recomputing timing and incrementing invalid samples, and the remote branch SHA lookup was not anchored to the exact `refs/heads/<branch>` target. The worktree resolver and other already-ported fixes remain in place and were revalidated with the focused regression suite.

## Files touched

- `scripts/sprites/pipeline-timing.ts`
- `scripts/sprites/queue-repair.ts`
- `tests/unit/sprites/pipeline-timing.test.ts`
- `docs/knowledge/handoffs/2026-09-05-sprite-pipeline-queue-fixes.md`

## Verification

- `npx vitest run tests/unit/sprites/pipeline-timing.test.ts tests/unit/sprites/queue-repair.test.ts --reporter=dot`
- `node --test .github/extensions/shared/tests/node-modules-resolver.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None known.

## Recommended next steps

- Keep the exact-ref lookup and snapshot memoization in place as the default pattern for future queue and timing utilities.
- If a future backport adds additional sprite-workflow fixes from PR #3234, re-run the targeted regression suite before merging.
