# Session Handoff: Material gain floater events

## Date

2026-08-22

## Persona

UX Designer

## Systems touched

inventory, vfx, hud-ux

## Apples

3🍎 actual, 📉 Under — the original implementation crossed the shared, core, and engine floater pipeline and required real-scene coverage.

## What Was Done

Added `materialGain` floater events when harvest completion grants an item and
when a collected floor drop is tagged `Materials`. Each event labels the grant
as `+1 <item name>` and reuses `CombatVfx` for non-combat floating text.

Added ECS and renderer contract coverage, then added deterministic real-scene
coverage in `tests/e2e/material-gain-floater.deterministic.test.ts`. The test
boots `MainGameScene` through the probe lab, picks up `iron-ore`, and observes
the live `+1 Iron Ore` Phaser text. Before this repair, only the mocked
`CombatVfx` path was covered.

## Verification

- `npx vitest run tests/e2e/material-gain-floater.deterministic.test.ts`
  (passes in both E2E projects after pre-publish sync)
- `npm run verify:fast`

## Unresolved Issues

- None in the implementation.

## Recommended Next Steps

- Let CI run the complete PR suite and merge-train checks.
