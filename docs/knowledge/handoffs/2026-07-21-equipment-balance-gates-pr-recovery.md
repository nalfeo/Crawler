# Handoff: PR #1577 recovery follow-up

## Date

2026-07-21

## Persona

DevOps Engineer

## Systems touched

ci-policy, ai-combat-balance

## Summary

- updated the original equipment-balance handoff so it matches the shipped
  single-run `CombatEvent.fromActiveAbility` attribution path instead of the
  superseded paired-run subtraction design
- hardened `tests/unit/verify-fast-typecheck.test.ts` against transient CI
  teardown races by waiting briefly for descendant stub processes to exit after
  `verify-fast` handles `SIGTERM`
- added the missing PR-recovery ADR and 1-apple review ledger artifacts needed
  by repo prereq guards on this branch

## Files touched

- `docs/knowledge/handoffs/2026-07-18-equipment-balance-gates.md`
- `tests/unit/verify-fast-typecheck.test.ts`
- `docs/knowledge/adr/2026-07-21-active-ability-dps-event-attribution.md`
- `docs/knowledge/review-ledgers/2026-07-21-equipment-balance-gates-pr-recovery.review-ledger.json`

## Verification run

- `npx vitest run tests/unit/verify-fast-typecheck.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-21-equipment-balance-gates-pr-recovery.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- none found locally; the remaining step is CI re-running on the new pushed head

## Recommended next steps

- push this consolidated repair commit
- post `✅ Addressed in <sha>` markers on review comments `3618930354` and
  `3618930368`
- confirm GitHub Actions re-runs cleanly on the new head
