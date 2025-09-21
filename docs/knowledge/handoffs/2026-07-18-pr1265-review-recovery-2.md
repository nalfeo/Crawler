# Handoff: PR #1265 review recovery follow-up

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

docs-tooling

## Apples

Estimated 2 apples, actual 2 apples.

## What changed

- Aligned `docs/knowledge/epics/floor-2-equipment/STACKED-WORK-RECOVERY.md` with the enforced lifecycle contract: `stacked_work.rebase_to_main.complete` now documents the same `validated` / `superseded -> validated` dependency rule used by the validator.
- Repointed the Floor 2 epic state's A0 handoff and review-ledger evidence commits to a real branch commit (`8e9bb3208e8a4b4307401441525cfc76b3ac6d7d`) that already contains the recorded bytes, fixing offline evidence verification.
- Refreshed the canonical `offline-validator-and-focused-tests` evidence hash, updated the unit-test fixture commit constants, and anchored the focused-test evidence to local commit `71ad3b15d9a2ff1f4837b468d5e3cd3f8be1217c` so `epic:status` and the focused epic-status unit suite both validate cleanly.
- Added the required 2-apple review ledger scaffold at `docs/knowledge/review-ledgers/2026-07-18-pr1265-review-recovery-2.review-ledger.json`.

## Verification run

- `npx vitest run tests/unit/agent/epic-status.test.ts`
- `npm run epic:status -- floor-2-equipment`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-pr1265-review-recovery-2.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- Issue `#1264` still has no historical pre-code detailed plan comment, so the outdated PR review thread about that checkpoint can only be resolved as deterministic non-applicability after the branch-level merge recovery; it cannot be made literally true retroactively from this branch.
