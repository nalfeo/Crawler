# Session Handoff: Goobers attempt telemetry

## Date

2026-09-09

## Persona

QA Engineer

## Systems touched

ci-policy,mcp-tooling

## Apples

2🍎 estimated

## What Was Done

Added the missing Goobers attempt-telemetry contract for feature-PR runs so every attempt now carries a stable lineage key, per-stage elapsed timings, privacy-safe byte/token metadata, a normalized terminal outcome, and a matched-cohort summary hook for comparing delivery success against canonical-context behavior.

The contract validator now enforces those expectations in `.github/scripts/validate-goobers-contracts-schema.js` and `.github/scripts/validate-goobers-contracts.mjs`, and the regression coverage in `tests/unit/goobers-contracts.test.ts` asserts lineage, missing-field handling, and outcome emission without exposing prompt contents or credentials.

## Verification

- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run tests/unit/goobers-contracts.test.ts --reporter=dot`

## Risk

Low: the change only tightens Goobers contract validation and telemetry metadata; it does not alter gameplay logic or the runtime issue intake flow.
