# Session Handoff: Floor 1 special-room placement preferences

## Date

2026-06-27

## Persona(s) adopted

- **Producer** — coordinated the cross-cutting change across floor-generation config, Floor 1 scenario logic, and regression coverage.
- **Game Designer** — tuned Floor 1 room selection behavior.

## Routing verdict

✅ Right personas — the work changed Floor 1 scenario placement rules in `src/game/`, biome generator wiring in `src/core/map/generators/`, and regression tests for both.

## Apples

Estimated: 🍎 x 3  
Actual: 🍎 x 3  
Verdict: 🎯 Exact — two production files plus three regression updates, with headless-gate follow-up needed to keep all verified seeds within budget.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

- Changed Floor 1 special-room selection so:
  - the **welcome room** is chosen from the closest room-path tier from spawn,
  - the **welcome room, shopkeeper, and spell broker** prefer nearby low-door side rooms,
  - the fetch-item fallback stays in a reachable non-boss-gated room even on tiny/degenerate maps.
- Enabled `roomVariety` for the registry’s **dungeon** and **castle** biome generators so they also get the broader corridor / side-room post-processing already used by basic underground.
- Updated regression coverage for:
  - Floor 1 special-room selection behavior,
  - dungeon/castle registry room-variety wiring,
  - the shorter valid welcome-sign route now possible when the welcome room is intentionally closer to spawn.

## Validation

- `npm run verify:fast` ✅
- `npm run verify` ✅
- `bash scripts/agent/lab-gate-check.sh` ✅
- `parallel_validation` ✅ (CodeQL clean; code-review comments were advisory duplication/refactor suggestions only)

## Key Files Changed

- `src/game/floor1Scenario.ts`
- `src/core/map/generators/registry.ts`
- `tests/game/floor1-scenario.test.ts`
- `tests/game/welcome-signs.test.ts`
- `tests/ecs/map-generators.test.ts`

## Blockers

None.

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present this session — no telemetry section.
