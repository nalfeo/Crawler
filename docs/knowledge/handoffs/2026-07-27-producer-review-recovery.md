# Producer review-thread recovery

**Date:** 2026-07-27
**Session:** producer-review-recovery
**Apple estimate:** 3🍎

## Systems touched

agent-personas, docs-tooling, mcp-tooling

## Summary

Recovered PR #2086 from outstanding producer review threads by fixing the live
producer-contract issues and validating the remaining ledger concern against the
current deterministic validator.

## Changes

- Moved runtime/core plumbing detection in `scripts/agent/producer.ts` to run
  after domain detection so requests like runtime loot wiring keep the required
  `Systems Engineer` slice.
- Tightened success-gate detection so bare feature text like `"all tests"`
  no longer marks the contract as `READY`, while explicit outcomes like `all
  tests pass` still do.
- Broadened balancing triage so real gameplay-parameter changes without numeric
  targets still escalate to `HUMAN_GATE`, without misclassifying cosmetic damage
  UI requests.
- Expanded `tests/unit/producer.test.ts` with regressions for runtime-loot
  routing, the `all tests` false positive, gameplay-balance triage, and
  malformed decomposition validation (cycle, duplicate ID, dangling/self edge,
  invalid apple tier).
- Verified that the existing review ledger remains valid under the current
  review-ledger validator; the reviewer’s “third round invalid” claim does not
  match the enforced schema, so that thread should be answered as
  deterministically not applicable rather than edited around.

## Validation

- `git diff --check` ✅
- `npx --yes prettier@3.8.3 --check scripts/agent/producer.ts tests/unit/producer.test.ts` ✅
- Targeted `tsx` assertions covering all addressed review-thread cases ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-27-producer-contract-redesign.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ✅

## Follow-up

- CI should re-run the normal PR checks on the consolidated repair commit.
