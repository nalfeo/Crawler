# Handoff: PR #1519 epic evidence recovery

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## What changed

- Hardened git commit validation in `scripts/agent/epics/epic-status-lib.ts` by switching `commitExists` to `git rev-parse --verify <sha>^{commit}` so only commit objects pass.
- Required `commitExists` checks for canonical `handoff` and `review-ledger` evidence before reading content, preventing working-tree fallback from validating fabricated/missing commits.
- Added regression coverage in `tests/unit/agent/epic-status.test.ts` for fabricated-commit rejection on `handoff` evidence.
- Replied to all requested review-thread comments with the requested targets.

## Validation run

- `npm run test:unit -- tests/unit/agent/epic-status.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-pr1519-epic-evidence-recovery.review-ledger.json`
- `npm run verify:pr-prereqs` (initially failed before ledger/handoff existed; expected and fixed in-session)
- `parallel_validation` (Code Review clean, CodeQL no alerts)

## Unresolved issues

- Review thread `3607440953` (PR scope/title interpretation) is a substantive disagreement after separate-model validation and was left unresolved for human escalation.
