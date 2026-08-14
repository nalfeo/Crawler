# Handoff — Default optional purchases PR recovery

## Systems touched

ai-behavior-tree

## Summary

- Centralized optional-purchase resolution so the headless runner and AI Runner lab preserve canonical precedence, legacy opt-outs, and the enabled default.
- Replaced copied resolution tests with coverage of the shared production resolver, including persisted legacy lab state.
- Repaired the expired npm-audit fixture expectation that blocked Lightweight Checks after its exception was removed.

## Apples

- Estimated: 2🍎
- Actual: 2🍎

## Validation

- `node --test scripts/agent/security/npm-audit.test.mjs` ✅
- `npx vitest run tests/unit/ai/optional-purchases-flag.test.ts tests/unit/ai-runner-merchant-weapon-wiring.test.ts tests/unit/ai/headless-runner-cli-lib.test.ts` ✅
- `npm run typecheck` ✅
- `npm run format:check` ✅
- `npm run verify:fast` ✅
