# Handoff: blood-lance asset request

## Date

2026-07-19

## Persona

Graphics Designer

## Systems touched

sprite-workflow, sprite-pipeline

## Apples

Estimated 1🍎, actual 1🍎.

## Summary

- Added the missing Floor 2 weapon brief `briefs/weapons/blood-lance.yaml` for
  issue #1317 (`equipment/weapon/blood-lance` runtime key context).
- Added a focused regression test in
  `tests/unit/sprites/load-brief.test.ts` asserting the committed brief identity
  deterministically maps to `weapon.blood-lance` and
  `equipment/weapon/blood-lance`.
- Created and validated a 1🍎 review ledger:
  `docs/knowledge/review-ledgers/2026-07-19-blood-lance-asset-request.review-ledger.json`.

## Validation

- `npm run test -- tests/unit/sprites/load-brief.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-19-blood-lance-asset-request.review-ledger.json` ✅

## Unresolved / follow-up

- Posting the requested pre-code plan comment on issue #1317 was attempted, but
  GitHub API access from this environment returned HTTP 403 for both GraphQL and
  REST comment attempts. The plan should be posted manually on the issue if
  required before PR creation.
