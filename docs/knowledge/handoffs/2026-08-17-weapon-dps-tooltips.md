# Handoff: Weapon DPS tooltips

## Date

2026-08-17

## Persona

UX Designer

## Systems touched

weapons, inventory

## Apples

2🍎 estimated, 2🍎 actual.

## Summary

Implemented theoretical single-target DPS display for weapon inventory tooltips. The DPS value is calculated from the weapon definition/snapshot plus the player's current effective combat stats and current attack-speed status multiplier, then rendered as a stat line in the shared item tooltip.

## What changed

- Added `computeTheoreticalSingleTargetDps(...)` in `src/core/weapon-dps.ts`.
  - Uses runtime damage math for flat/percent damage, typed primary scaling, expected crit value, attack speed, cooldown reduction, and attack-speed status multipliers.
  - Mirrors runtime weapon affinity metadata: only `WeaponType.MAGIC` is magic affinity; beam/trap/ranged/thrown/melee are physical.
  - Counts beam boundary ticks to match the real pipeline ordering (`beamSystem` before `lifetimeSystem`).
  - Keeps AoE splash out of single-target DPS; magic weapons count the direct hit only.
- Updated `InventoryUI` to resolve static weapon defs and generated active weapon snapshots for tooltip DPS.
- Updated `item-tooltip` to support an optional single stat line without increasing tooltip height when absent.
- Added focused unit coverage in `tests/unit/weapon-dps.test.ts`.

## Validation

- `bash scripts/agent/preflight.sh`
- `npx vitest run tests/unit/weapon-dps.test.ts --reporter=dot`
- `npm run typecheck`
- `npm run verify:fast` (final rerun passed: 138 files / 2259 tests; fast verification passed)
- Secret scans on changed source/test files: no secrets detected
- Automated code review: multiple findings addressed; final rerun timed out after the last addressed finding and tool instructed not to rerun
- CodeQL checker: 0 alerts; JS analysis skipped because database size is too large

## Observe before done

Before: inventory tooltip rendering had no DPS stat-line path and no weapon DPS calculator.
After: focused deterministic tests prove DPS math for physical, magic, beam, crit/cadence, and attack-disabled cases; final fast verification covers the changed inventory/tooltip render surface.

## Notes

- `files/guard-telemetry.jsonl` was absent; no telemetry capture was required.
- No PR was opened because the user did not explicitly request one.
