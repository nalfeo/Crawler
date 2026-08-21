# Handoff: CI recovery duplicate-reply resolution

## Systems touched

ci-policy

## Summary

- Investigated CI Recovery loop incident #3217 for PR #3206 using the unresolved review thread and workflow run `32490677490`.
- Root cause: `shouldResolveThread()` only inspected the final review-thread comment, so a trusted bot no-op reply (`Duplicate reply skipped — already posted above.`) masked an earlier valid `✅ Addressed in <head>` marker and prevented `resolveReviewThread` from running.
- Fixed the resolver to treat only that exact trusted duplicate-skip note as transparent when selecting the effective latest comment.
- Added state-level and live reconcile regressions proving trusted duplicate notes resolve while untrusted/no substantive follow-up does not.

## Files touched

- `.github/scripts/ci-recovery/state.mjs`
- `.github/scripts/ci-recovery/state.test.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-08-21-ci-recovery-duplicate-reply.review-ledger.json`
- `docs/knowledge/handoffs/2026-08-21-ci-recovery-duplicate-reply.md`

## Verification run

```bash
node --test .github/scripts/ci-recovery/state.test.mjs
node --test .github/scripts/ci-recovery/state.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs --test-name-pattern 'shouldResolveThread|duplicate-reply'
bash scripts/agent/preflight.sh
npm run verify:fast
npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-21-ci-recovery-duplicate-reply.review-ledger.json
```

## Unresolved issues

- The requested pre-code issue plan comment could not be posted from this sandbox because the shell has no `GH_TOKEN`/`GITHUB_TOKEN`; the full plan was recorded in progress updates and should be included in the PR description.

## Recommended next steps

1. Rerun `npm run verify:pr-prereqs` after this handoff is committed.
2. Let CI Recovery reprocess PR #3206 after this fix lands; the blocker thread should now reach `resolveReviewThread` instead of dispatching another repair task.
