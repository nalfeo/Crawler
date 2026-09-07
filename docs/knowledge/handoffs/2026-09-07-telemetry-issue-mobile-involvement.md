# Handoff: Telemetry issue mobile involvement

## Date

2026-09-07

## Persona

DevOps Engineer

## Systems touched

azure-infra, ci-policy

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Summary

Every GitHub issue filed by the dev-build telemetry ingest now includes
`Involved: @nalfeo` in its body. The explicit mention makes player reports and
survey-only telemetry discoverable through GitHub's `involves:@me` mobile filter
without assigning the issue, which preserves the unassigned Goobers intake
contract.

Regression coverage checks both issue variants and guards the filing source
against losing the mention.

## Files touched

- `functions/dev-build-ingest/src/index.ts`
- `tests/unit/dev-build-ingest-handler.test.ts`
- `tests/unit/dev-ingest-workflow-parity.test.ts`
- `docs/knowledge/handoffs/2026-09-07-telemetry-issue-mobile-involvement.md`

## Verification

- `npx vitest run --project unit tests/unit/dev-build-ingest-handler.test.ts tests/unit/dev-ingest-workflow-parity.test.ts` — passed (20/20).
- `npm run verify:fast` — passed.
- `npm run verify:pr-prereqs` — passed.

## Unresolved issues

- Existing telemetry issues are unchanged; the filing contract applies to new
  issues.
