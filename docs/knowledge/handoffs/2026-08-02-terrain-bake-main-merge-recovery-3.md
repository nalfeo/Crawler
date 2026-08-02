# Handoff: terrain bake main-merge recovery 3

## Date

2026-08-02

## Persona

DevOps Engineer

## Systems touched

mapgen, sprite-pipeline

## Apples

2🍎 exact

## Summary

Recovered PR #2694 from the latest `origin/main` drift and the resulting CI blockers:

- merged `origin/main` into `copilot/optimize-build-terrain-layer` and resolved the two live conflicts;
- kept main's newer welcome-room asset-reconcile sizing in `src/shared/data/set-pieces.json` so the PR no longer silently reverts the upstream sprite metadata pass;
- updated `tests/unit/extensions/asset-search-index-builder.test.ts` to pin the current `cactusfolk-boss` brief text while preserving the stricter full-description equality check;
- corrected the two earlier merge-recovery handoffs so they describe the branch's final state instead of the superseded temporary rug override.

## Validation

- `npx vitest run tests/unit/extensions/asset-search-index-builder.test.ts tests/unit/set-piece-declared-feet.test.ts tests/unit/stamp-set-piece.test.ts tests/unit/set-piece-types.test.ts`
- `npm run check:silent-reverts` (warn-only branch-local discard on the merge commit; 0 blocking findings)
- `bash scripts/agent/verify-fast.sh`
- `npm run verify:pr-prereqs`

## Notes

- The sandbox's existing `node_modules` was missing `tsx`, so local verification required a temporary, non-committed `package-lock.json` tarball-host rewrite from `ms-feed-*.pkgs.visualstudio.com` to `registry.npmjs.org` long enough to run `npm ci --ignore-scripts`; `package-lock.json` was restored immediately afterward.
- `files/guard-telemetry.jsonl` was absent, so no telemetry capture file was needed.
