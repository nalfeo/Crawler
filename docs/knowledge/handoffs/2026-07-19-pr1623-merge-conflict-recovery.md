# Handoff: PR #1623 merge-conflict recovery

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Merged `origin/main` into `copilot/ci-recovery-loop-issue-1265`, resolved the lone content conflict in `.github/scripts/ci-recovery/reconcile.mjs`, and updated the new reconcile regressions so they still exercise the stale-marker and prior-reply blocker-summary paths after `main`'s newer outdated-thread auto-resolution behavior.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/handoffs/2026-07-19-pr1623-merge-conflict-recovery.md`

## Observe before done

- Before: merging `origin/main` stopped on `.github/scripts/ci-recovery/reconcile.mjs` because `main` added the shared `ADDRESSED_MARKER_REPLY` guidance while this branch added `KNOWN_RECOVERY_REPLY_LOGINS` plus prior-reply task-body text.
- After: the merged reconciler keeps both behaviors, and the stale-marker / prior-reply regressions now run on non-outdated threads so they remain valid after `main` began auto-posting addressed markers for `isOutdated` threads.

## Verification run

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Notes

- `files/guard-telemetry.jsonl` was absent in this session, so no telemetry capture file was required.
