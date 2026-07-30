# 2026-07-30 Dead-code signal hygiene: test-only export guard + knip suppression expiry

## Summary

Implements two blocking CI guards addressing issue #2362 (two dead-code blind spots in the existing knip-based dead-code detector):

1. **Test-only exports guard** (`check:test-only-exports`): AST-based TypeScript check that flags any `src/` export whose only consumers are under `tests/**`. Closes the systematic blind spot where a fully unit- and property-tested export can ship dead — the textbook case being `listInventoryEntries` in `src/shared/inventory.ts`.

2. **Knip suppression expiry guard** (`check:knip-suppressions`): Structured `KNIP_SUPPRESSIONS` list with required `reason` + `expiresOn` fields replaces `knip.json`'s raw `ignoreIssues` map. Expired entries fail CI; bumping `expiresOn` without also updating `reason` also fails CI (reason-restatement rule). Pattern follows `AUDIT_EXCEPTIONS` in `scripts/agent/security/npm-audit.mjs`.

### Dead code fixed
- `listInventoryEntries` deleted from `src/shared/inventory.ts` (zero production callers; unit- and property-tested but never called from engine code). Tests rewritten to use `hasGeneratedEquipmentReference` and direct bag-state assertions.

### Suppressions triaged (issue #2362 ask)
- 9 reward/equipment file suppressions re-added with explicit `reason` + `expiresOn: 2026-09-30`. The files themselves ARE wired in production, but specific exports within each (constants, type aliases, interface definitions) remain unused. Each suppression entry enumerates the residual dead exports and provides actionable remediation notes.
- 2 pre-existing suppressions (`sprite-approval-api.ts`, `mob-motion.ts`) carried forward with reason+expiry.

## Systems touched

`tooling`, `inventory`, `ai`, `shared`

## Files touched

### New files
- `scripts/agent/health/test-only-exports-lib.ts` — pure AST library (collectNamedExports, collectNamedImports, findTestOnlyExports, findDuplicateExportNames)
- `scripts/agent/health/test-only-exports.ts` — blocking runner script
- `scripts/agent/health/knip-suppressions.ts` — KNIP_SUPPRESSIONS list + pure validation logic
- `scripts/agent/health/check-knip-suppressions.ts` — runner for expiry/reason-restatement check
- `knip.config.ts` — TypeScript knip config (replaces knip.json); derives ignoreIssues from KNIP_SUPPRESSIONS
- `tests/unit/agent/test-only-exports.test.ts` — unit tests for AST lib
- `tests/unit/agent/knip-suppressions.test.ts` — unit tests for suppression validation

### Modified files
- `knip.json` — DELETED (replaced by knip.config.ts)
- `src/shared/inventory.ts` — deleted `listInventoryEntries` function
- `tests/unit/inventory.test.ts` — removed 2 test cases for deleted function
- `tests/property/inventory-properties.test.ts` — rewrote 2 property tests; duplicate-rejection test now asserts exact count via `bag.generatedEquipment.filter(...)` not boolean `hasGeneratedEquipmentReference`
- `package.json` — added `check:test-only-exports` and `check:knip-suppressions` npm scripts
- `.github/workflows/ci.yml` — added two new blocking CI steps in `check-format-and-labs` job
- `tsconfig.json` — added `knip.config.ts` to include list
- `docs/knowledge/review-ledgers/2026-07-30-dead-code-signal-hygiene.review-ledger.json` — review ledger

## Verification run

- `verify:pr-prereqs` — passes after handoff written
- `review:ledger validate` — passes (3🍎 ledger with plan_review + code_review)
- Unit tests could not run locally (private registry inaccessible in sandbox); CI will validate
- Guard logic verified by manual code trace through all test cases

## Known limitations of test-only-exports guard

Documented in `test-only-exports-lib.ts`:
- `export * from '...'` barrels not tracked as src consumers (not used in this codebase — all barrels use named re-exports)
- `import type` counts same as value imports (acceptable approximation for value-deadness detection)
- Name-based (not module-path-based): rare same-name exports across two files can shield one another

## Unresolved issues

- All 11 suppressed files in `KNIP_SUPPRESSIONS` (9 reward/equipment + sprite-approval-api + mob-motion) should have their residual dead exports cleaned up or consumed before 2026-09-30. The per-entry `reason` fields enumerate the specific dead exports.

## Recommended next steps

1. CI will validate unit tests for the new guards on first merge
2. A follow-on PR should delete `LOOT_BOX_RESOLVER_VERSION` and `REWARD_BUNDLE_RESOLVER_VERSION` (used only internally, no external callers) rather than keeping them suppressed — the suppression buys time but unexporting is the right fix
3. Consider running `npm run check:test-only-exports` during local development (e.g., via `verify:fast`) once the guard proves stable in CI

## Apple estimate

🍎🍎🍎 (tooling-only, capped at 3🍎)
