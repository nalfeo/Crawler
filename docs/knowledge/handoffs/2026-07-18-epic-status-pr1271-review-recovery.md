# 2026-07-18 — PR #1271 review recovery

## Systems touched

ci-policy, docs-tooling

## Summary

- tightened epic-status git validation so merge facts now require real commit objects, not just any git object
- restored trimmed non-empty ownership metadata validation and child-issue BLOCKED backward compatibility
- distinguished scheme-based `check:` evidence from repository files and emitted explicit `evidence.commit-unavailable` warnings when verification falls back to working-tree content because a commit is missing locally
- updated epic-status unit tests to pin evidence hashes to commit-addressed content and added regressions for non-commit merge facts, whitespace-only ownership, canonical fallback warnings, and child-issue BLOCKED revocation

## Files touched

- `scripts/agent/epics/epic-status-lib.ts`
- `tests/unit/agent/epic-status.test.ts`

## Verification run

- `npm run test:unit -- tests/unit/agent/epic-status.test.ts`
- `npm run typecheck`
- `npx eslint scripts/agent/epics/epic-status-lib.ts tests/unit/agent/epic-status.test.ts`
- `npm run epic:status -- floor-2-equipment --materialization-plan`
- `npm run verify:pr-prereqs`
- `npm run verify:fast`

## CI notes

- Existing branch checks on head `86733949` were queued/pending rather than red; GitHub Actions shows the old `CI` / `Security Review Loop` runs were bot-authored queued runs, while the current dynamic recovery workflow is in progress on the latest branch head.

## Unresolved issues

- None locally once the latest `verify:fast` rerun completes.
