# Asset Request CI Recovery

**Date:** 2026-07-16
**Session:** PR #1213 CI recovery
**Apple estimate:** 1

## Summary

Recovered the failing Advisory checks gate on the asset-request size-variant PR.
The new legacy-claim matcher in `issue-ingester-controller.ts` used a table-level
generic that widened `T[string]` too far for TypeScript, so `npm run typecheck`
and CI failed even though runtime behavior was correct. Narrowed the helper to a
row-level generic and reused the looked-up legacy row, preserving behavior while
making the inferred type concrete.

## Systems touched

sprite-workflow

## Files touched

- `scripts/sprites/sidecar/issue-ingester-controller.ts` — narrow `matchingStateRow` to a row generic so current and legacy matches typecheck cleanly

## Verification

- `npm run typecheck`
- `npx vitest run tests/unit/sprites/issue-ingester-controller.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

None.
