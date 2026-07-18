# Handoff: CI recovery outdated-thread stale-marker fix

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 1🍎, actual 1🍎.

## Summary

Fixed a CI recovery loop stall on PR #1399 caused by a thread where the last
`✅ Addressed` reply used a conventional-commit prefix (`fix(art):`) as the
"SHA" token instead of a real hex SHA. `shouldResolveThread` returned `false`
because `parseMarkerShaToken("fix(art):")` returned `null`. The thread stayed
as a blocker across 2 recovery attempts, and the automation stalled.

## Root cause

`shouldResolveThread` in `.github/scripts/ci-recovery/state.mjs` had only one
resolution path: `isTrustedComment(last) && markerNamesHead(...)`. When the
marker token was not a valid hex SHA or commit URL, `markerNamesHead` returned
`false` even for outdated threads where the original code line was gone.

## What changed

- `.github/scripts/ci-recovery/state.mjs`: added a second resolution path in
  `shouldResolveThread` — if the thread is `isOutdated === true` AND the last
  comment is from a trusted author AND contains `✅ Addressed` (any format),
  the thread is resolved as "deterministic non-applicability" per ADR 0058
  DEC-008. Also added `addressedMarkerPattern` constant.
- `.github/scripts/ci-recovery/state.test.mjs`: added 4 unit tests covering
  - outdated + trusted + no-SHA marker → resolves
  - outdated + untrusted → rejects
  - outdated + trusted + no marker → rejects
  - not-outdated + trusted + no-SHA marker → rejects
- `.github/scripts/ci-recovery/reconcile.test.mjs`: added 1 integration test
  confirming that the reconciler live-resolves only the outdated+trusted thread.

## Observe before done

- Before: reconcile.mjs created a loop-incident after 2 stall attempts because
  the thread with `✅ Addressed in fix(art): ...` could never be auto-resolved.
- After: `shouldResolveThread` returns `true` for the thread and the reconciler
  would call `resolveReviewThread` to close it, unblocking auto-merge.
- Verified via: `node --test .github/scripts/ci-recovery/state.test.mjs` (35/35
  pass) and `node --test .github/scripts/ci-recovery/reconcile.test.mjs` (85/85
  pass).

## Verification run

- `node --test --test-name-pattern "shouldResolveThread" .github/scripts/ci-recovery/state.test.mjs`
- `node --test .github/scripts/ci-recovery/state.test.mjs`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
