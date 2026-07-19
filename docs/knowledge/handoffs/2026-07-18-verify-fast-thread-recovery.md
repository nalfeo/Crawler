# Handoff: verify-fast review-thread recovery

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

verify-fast, ci

## Apples

Estimated 2 apples, actual 2 apples.

## What changed

- Made `tests/unit/verify-fast-typecheck.test.ts` invoke TypeScript portably via `process.execPath` + `require.resolve('typescript/bin/tsc')` instead of `node_modules/.bin/tsc`.
- Relaxed the source-string assertion so it still accepts harmless `--project ./tsconfig.json` / quoted-path variants.
- Switched the config assertion from raw `tsconfig.json` parsing to `tsc --showConfig --project tsconfig.json`, so future `extends` chains stay covered.
- Removed the throwaway test fixture's `moduleResolution: 'bundler'` setting because the regression only needs TS2339 behavior, not bundler-specific semantics.

## Observe before done

- Before: the regression suite was correct in spirit but still had the three portability/brittleness issues called out in PR review.
- After: the same four regression checks pass while using a platform-agnostic TypeScript entry point and resolved-config inspection.

## Verification run

- `npx vitest run tests/unit/verify-fast-typecheck.test.ts`
- `npm run typecheck`
- `npm run verify:fast` _(still fails on pre-existing `tests/unit/agent/epic-status.test.ts` ambiguous-git-object case, unchanged by this repair)_
- GitHub Actions inspection for PR #1576: listed branch workflow runs/jobs and confirmed the current CI run has no failed jobs, only queued jobs.

## Unresolved issues

- `npm run verify:fast` is still red on the already-known `tests/unit/agent/epic-status.test.ts` failure (`fatal: ambiguous argument '461b8a334a018ebbf6e81aa7b31f81c74e08aa6b^{tree}'`), which is outside this PR's touched area.
