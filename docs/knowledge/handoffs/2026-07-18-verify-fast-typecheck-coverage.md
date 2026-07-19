# Handoff: verify:fast typecheck coverage — 2026-07-18

## Systems touched

verify-fast, ci

## Problem

`scripts/agent/verify-fast.sh` ran `tsc --project tsconfig.src.json` which excludes `tests/` and `scripts/`. A TS2339 error in a changed test file therefore produced a false-green local gate. `npm run typecheck` correctly caught the error; `npm run verify:fast` did not.

Reproduced on d858c905 with `tests/unit/shared/generated-equipment-generator.test.ts`.

## Fix

One-line change in `scripts/agent/verify-fast.sh`:

```diff
-npx tsc --noEmit --project tsconfig.src.json &
+npx tsc --noEmit --project tsconfig.json &
```

`tsconfig.json` includes `src/**/*.ts`, `tests/**/*.ts`, and `scripts/**/*.ts` — the same set as `npm run typecheck`. Performance is preserved: the config has `incremental: true` and writes `.tsbuildinfo`, so subsequent runs only recheck changed files.

## Regression test

Added `tests/unit/verify-fast-typecheck.test.ts` with four deterministic checks:

1. Source-string guard: `verify-fast.sh` references `tsconfig.json` not `tsconfig.src.json`
2. Source-string guard: `tsconfig.json` includes `tests/**/*.ts`
3. Functional: `tsc --noEmit` exits non-zero for a TS2339 error in a test file
4. Functional: `tsc --noEmit` exits 0 for a clean test file

## Verification

- `npm run typecheck` — ✅ clean
- `npx vitest run tests/unit/verify-fast-typecheck.test.ts` — ✅ 4/4 pass
- `npm run verify:fast` — ✅ all gates pass (1 pre-existing epic-status.test.ts failure unrelated to this change)
