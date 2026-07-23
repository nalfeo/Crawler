# Handoff: Blood pool variance + enemy-size scaling

## Date

2026-07-23

## Persona

Graphics Designer

## Systems touched

vfx, enemies

## Apples

Estimated: 🍎🍎  
Actual: 🍎🍎

## Summary

- Increased deterministic blood-pool silhouette variance in the authoritative blood-surface model by:
  - varying lobe count per pool,
  - widening lobe radius/offset jitter,
  - biasing lobe offsets along a dominant axis for less oval symmetry,
  - widening per-lobe spread timing (`growAt`) and non-core initial scales.
- Added enemy-size-aware initial pool scaling in `createBloodPoolSurface`.
- Wired `dropSystem` to pass each slain enemy's body size (from ECS `Size`) into pool creation.
- Added focused tests for size scaling and variance behavior.

## Files touched

- `/home/runner/work/Crawler/Crawler/src/shared/blood-surfaces.ts`
- `/home/runner/work/Crawler/Crawler/src/core/systems/dropSystem.ts`
- `/home/runner/work/Crawler/Crawler/tests/unit/blood-surfaces.test.ts`
- `/home/runner/work/Crawler/Crawler/tests/ecs/drop-system.test.ts`

## Verification

Attempted, but blocked by dependency installation/network constraints in this environment:

- `npm run test:unit -- tests/unit/blood-surfaces.test.ts tests/ecs/drop-system.test.ts`
  - failed: `vitest: not found` (no installed node_modules).
- `npm run verify:fast`
  - failed because project dependencies are missing (`@eslint/js`, TypeScript toolchain).
- Dependency bootstrap attempts:
  - `bash scripts/agent/preflight.sh` → failed at `npm ci`.
  - `npm ci` → failed with `ENOTFOUND` to `ms-feed-12.pkgs.visualstudio.com`.

## Unresolved issues

- Could not post the required issue plan comment through `gh issue comment` due API permission error (`HTTP 403` in this environment).
- Full local verification remains blocked until dependencies can be installed.

## Recommended next steps

1. Ensure package installation can reach required registry endpoints, then rerun:
   - `npm run test:unit -- tests/unit/blood-surfaces.test.ts tests/ecs/drop-system.test.ts`
   - `npm run verify:fast`
2. Post the implementation plan summary on issue #1798 once credentials with issue-comment scope are available.
