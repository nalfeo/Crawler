# Handoff: CI recovery scope-mismatch loop bound

## Systems touched

ci-recovery, ci-policy

## Apples

Estimated: 3. Actual: 3.

## Summary

Implemented the scope-mismatch/non-converging review recovery guard for issue #3203.

- Recovery-authored review-thread marker/comment churn no longer changes the blocker fingerprint for the same underlying thread finding, so comment-only attempts count against the same retry budget.
- The operator state comment now explicitly reports `stale-automation-exhausted`, retry count, and the next human/operator action when automation exhausts.
- Trusted review findings that say a PR's title/body/closing reference promises work unsupported by its diff now quarantine the PR instead of dispatching another `@copilot` repair task.
- Quarantine comments now support scope-specific explanations and next actions (`KEEP` or `ABANDON`).
- Exact owner `ABANDON` on a quarantined PR strips same-repo closing keywords, releases ownership, closes/marks the PR abandoned, and restarts linked issue intake with a real Copilot remove/reassign edge. Exact `KEEP` revives the PR without same-pass dispatch.

## Validation

- `bash scripts/agent/preflight.sh`
- `node --test .github/scripts/ci-recovery/state.test.mjs .github/scripts/ci-recovery/pr-lifecycle.test.mjs .github/scripts/ci-recovery/issue-intake.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npx prettier --check .github/scripts/ci-recovery/state.mjs .github/scripts/ci-recovery/state.test.mjs .github/scripts/ci-recovery/pr-lifecycle.mjs .github/scripts/ci-recovery/issue-intake-lib.mjs .github/scripts/ci-recovery/issue-intake.test.mjs .github/scripts/ci-recovery/reconcile.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run sync:main -- --reason pre-publish && npm run verify:fast` (green locally after rebase; remote push of the rebased branch was blocked by the progress tool's signing failure, so the published branch was reset to the already-pushed implementation commit)

## Notes

- The requested pre-code issue plan comment could not be posted from this session: `gh issue comment` had no authenticated `GH_TOKEN`/`GITHUB_TOKEN`, and no issue-comment write tool was available. The plan was recorded through progress updates and should be included in the PR description.
- The progress tool failed when trying to push the pre-publish-rebased branch because its internal rebase/signing path errored with a GPG signing `Bad Request`. The implementation commit was already pushed before that sync, so the local worktree was reset back to the pushed branch tip before adding this handoff.
