# CI recovery: file deduplicated investigation issues on stale-automation-exhausted

## Date

2026-07-17

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples. The work was contained to the existing CI Recovery state machine: one new library module (`loop-incident-lib.mjs`), one call-site change in `reconcile.mjs`, and corresponding test updates.

## Summary

Added deduplicated investigation issue filing to the CI recovery reconciler's stale-automation-exhausted path. When automation exhausts its retry budget on a PR (same head SHA + blocker fingerprint for 3+ no-progress cycles), the reconciler now files a single `ci-loop-incident` GitHub issue before releasing ownership. Subsequent events for the same PR update the existing issue (incrementing repetition count and last-seen timestamp) rather than creating duplicates.

PR nalfeo/Crawler#1243 exposed the failure mode: the marker-resolution loop drove continuous recovery churn for many hours while no investigation issue was filed. The fix ensures that once the automation stalls, a managed issue activates the existing `issue-copilot-intake.yml` workflow exactly once.

## Files touched

- `.github/scripts/ci-recovery/loop-incident-lib.mjs` — NEW: fingerprint, body builder, and `fileLoopIncident` API
- `.github/scripts/ci-recovery/loop-incident-lib.test.mjs` — NEW: 14 tests covering pure-function invariants, sanitization, PR #1243 replay, deduplication, and idempotent label creation
- `.github/scripts/ci-recovery/reconcile.mjs` — imported `fileLoopIncident`; added `workflowRunUrl` constant; added loop-incident filing in the `staleAction === 'release'` branch (live mode) and dry-run logging
- `.github/scripts/ci-recovery/reconcile.test.mjs` — updated stale-automation-exhausted (attempt=2) test to expect loop incident creation; added dry-run test asserting `would-file-loop-incident` log without mutations
- `.github/scripts/ci-recovery/review-wake-bridge.mjs` — added `loop-incident-lib.mjs` to `PROTECTED_WORKFLOW_PATHS`
- `.github/scripts/ci-recovery/review-wake-bridge.test.mjs` — updated `protectedPaths` fixture to match
- `docs/knowledge/review-ledgers/2026-07-17-ci-recovery-loop-incident-filing.review-ledger.json` — 2-apple ledger

## Key decisions

- **One issue per PR**: Deduplication is title-based (`CI recovery loop: PR #N`), scoped to the `ci-loop-incident` label. This is the same pattern as `incident.mjs` for repository-level incidents.
- **No explicit Copilot assignment**: The `issue-copilot-intake.yml` workflow fires on `issues: opened`, which handles assignment exactly once. Subsequent updates do not re-trigger intake.
- **Sanitization**: Untrusted blocker summaries (from PR review threads and CI check output) are placed in a dedicated blockquote section visually and textually separated from the investigation prompt. The prompt contains only controlled text.
- **Dry-run logging**: In dry-run mode, `fileLoopIncident` is not called; instead a `dry-run would-file-loop-incident` line is logged to stdout, matching the pattern of all other dry-run log lines in reconcile.mjs.
- **No separate incident table / workflow**: Reuses the existing `ci-loop-incident` label, title-based deduplication, and the `issue-copilot-intake.yml` intake path. No new workflow file was needed.
- **`PROTECTED_WORKFLOW_PATHS` updated**: `loop-incident-lib.mjs` is imported by `reconcile.mjs` (a privileged default-branch script), so it must be listed as a protected path. The review-wake-bridge security gate enforces this.

## Verification

- `node --test .github/scripts/ci-recovery/*.test.mjs` — 209 tests pass (14 new in loop-incident-lib.test.mjs, 1 new dry-run test in reconcile.test.mjs, updated assertions in the stale-automation-exhausted test)
- `npm run verify:fast` — all 1260 Vitest tests pass + physics checks
- `npm run test:guards` — 1093 guard tests pass
- `npm run review:ledger -- validate` — valid 2-apple ledger

## Unresolved issues

None.

## Recommended next steps

- The `resolved loop incident` story: once the root-fix PR merges and recovery converges on the affected PR, the loop incident should be closed automatically. A future enhancement could detect convergence (automation owns the PR → status=idle after successful recovery) and close the open `ci-loop-incident` issue. This is explicitly out of scope for this session.
- The "trusted agent explicitly identifies a defect" trigger (second prong of the issue's trigger policy) is not yet implemented. This would require a structured signal from a recovery agent (e.g., a PR comment with a specific machine-parseable marker) that the reconciler could recognize as a termination signal. This is a separate feature.
