# Handoff: PR #1271 live-claim + GitReader compatibility recovery

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Recovered PR #1271 blockers by hardening epic-status reconciliation and preserving exported GitReader compatibility:

- `auditGithub` now emits `github.missing-live-claim` when an active cached owner has no live trusted CLAIMED comment.
- `GitReader` now supports both the current (`readContent`/`commitStatus`) and legacy (`showContent`/`commitExists`/`not-a-commit`) shapes.
- Added targeted regression tests for both behaviors.

## Files touched

- `scripts/agent/epics/epic-status-lib.ts`
- `tests/unit/agent/epic-status.test.ts`
- `docs/knowledge/review-ledgers/2026-07-18-epic-status-pr1271-live-claim-recovery.review-ledger.json`

## Verification run

- `npm run test:unit -- tests/unit/agent/epic-status.test.ts`
- `npm run epic:status -- floor-2-equipment`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-epic-status-pr1271-live-claim-recovery.review-ledger.json`

## Unresolved issues

- `npm run verify:pr-prereqs` still reports only the expected pre-existing need to include this session's handoff/ledger until those files are committed.

## Recommended next steps

- Reply in the listed review threads with `✅ Addressed in <sha>` markers after commit.
- Re-run `npm run verify:pr-prereqs` after commit to confirm guard compliance.
