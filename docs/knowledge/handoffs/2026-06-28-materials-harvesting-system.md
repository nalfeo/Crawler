# Session Handoff: Materials Harvesting System

## Date

2026-06-28

## Persona(s) adopted

**Producer** — multi-layer feature spanning ECS (Systems Engineer), game content
(Game Designer + Content Designer), engine rendering (UX Designer), and tests
(QA Engineer).

## Routing verdict

✅ right persona — cross-cutting feature required Producer to orchestrate four
specialist layers simultaneously.

## Apples

Estimated: 🍎🍎🍎🍎🍎 x 1 (Massive — full new feature)
Actual: 🍎🍎🍎🍎🍎 x 1
Verdict: 🎯 Exact — scope matched estimate exactly.

Hello kitties: 5/5 = 1.00 🎀

## Systems touched

quests

## What Was Done

### Data layer

- Added 6 new floor-1 material items to `ITEM_CATALOG` in `src/shared/items.ts`
  (crimson-mushroom, azure-mushroom, sunpetal-flower, moonbloom-flower,
  frost-lichen, shadow-lichen). All tagged `Materials` + `Flora`.
- Created `src/shared/harvestableDefs.ts` — stable-index registry of 6
  `HarvestableDef` objects with id, label, itemId, durationMs, tint,
  maxPerFloor.
- Added 6 art-plan entries to `plans/item-icons/materials.art.yaml`.

### ECS layer

- `Harvestable` component tag + `harvestable` store (defIndex, durationMs,
  progressMs, harvesterEid) in `src/core/components.ts`.
- Store wired in `src/core/world.ts` via `wireStore`.
- `spawnHarvestableNode(world, x, y, defIndex)` in `src/core/helpers.ts`.
- `harvestSystem(world)` in `src/core/systems/harvestSystem.ts`:
  - 1 ft proximity range (`HARVEST_RANGE_FT`).
  - Increments `progressMs` by `GAME.DELTA_MS` per tick.
  - On completion: `addItem` + `removeEntity` + `pickupSparkle` VFX.
  - Resets on leaving range.
- Exported from `src/core/systems/index.ts`.

### Engine layer

- `src/engine/PhaserBridge.ts`: harvestable entities render as colored body
  circles (def.tint) + per-entity `Phaser.GameObjects.Graphics` for the
  circular progress arc (dark background ring + green fill arc from −π/2
  clockwise). Cleanup on entity removal + scene destroy.
- `src/engine/scenes/MainGameScene.ts`: `harvestSystem` ticked after
  `itemPickupSystem`.

### Game layer

- `src/game/floorScenario.ts`: `spawnFloor1HarvestableNodes()` spawns 2–5
  nodes per def in NORMAL/SPAWN rooms using `world.rng`, enforces 3 ft
  minimum same-type spacing. Called at end of `initializeFloor1Scenario()`.

### Lab + tests

- `src/labs/harvest-lab/index.ts` — HTML canvas lab with player X control,
  speed multiplier, inventory readout, and progress arcs per node.
- `src/lab-main.ts` — registered `harvest-lab`.
- `scripts/agent/pr-lab-links.mjs` — mapped `harvestSystem` + `harvestableDefs`.
- `tests/ecs/harvestSystem.test.ts` — 12 unit tests (all passing).
- `tests/unit/items.test.ts` — updated catalog snapshots.

### ADR

- `docs/knowledge/adr/0030-materials-harvesting-system.md`

## What's Next

- Add sprite assets for the 6 new material items (current state: procedural
  placeholder circles/icons). Use `npm run sprites:plan-drafts`.
- Consider adding a tooltip/label above the node when the player is close
  enough to harvest (shows item name + duration).
- Consider partial harvest persistence (progress saves if player briefly
  leaves, decays slowly rather than instant reset).
- Future floors can extend `HARVESTABLE_DEFS` with new node types — the
  append-only registry keeps defIndex stable.

## Blockers

None. All CI gates pass locally.

## Branch State

- Branch: `copilot/fix-148`
- All tests passing: yes (916/916)
- PR created: yes

## Agent-OS Telemetry

No `files/guard-telemetry.jsonl` present in this session.

## Test Results

- `npm run verify:fast` ✅ (916 tests)
- `bash scripts/agent/lab-gate-check.sh` ✅
- `npm run verify` ✅ (full suite + build)

## Key Decisions Made

- **Fixed delta (`GAME.DELTA_MS`) vs wall-clock time** — used fixed delta to
  keep the harvest system deterministic and replay-safe (see ADR-0030).
- **PhaserBridge per-entity Graphics** — followed the same pattern as
  `beamGraphics` / `arcGraphics` for the progress ring; no separate HUD
  component since this is world-space attached to the node.
- **Progress resets on range exit** — chosen for clarity and simplicity; the
  player must maintain proximity for the full duration.
- **HARVESTABLE_DEFS is append-only** — indexed array, never reorder; documented
  in the registry header and ADR.
