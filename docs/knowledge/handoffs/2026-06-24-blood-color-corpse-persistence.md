# Session Handoff: Blood colour per mob + persistent corpses + blood pools

## Date

2026-06-24

## Persona(s) adopted

Producer — multi-layer feature spanning shared types, core ECS, game scenario, and
engine VFX renderer.

## Routing verdict

✅ Right call — the task touched `src/shared`, `src/core`, `src/game`, and
`src/engine` simultaneously, requiring Producer-level layer-rule awareness.

## Apples

Estimated: 🍎🍎🍎🍎
Actual: 🍎🍎🍎🍎
Verdict: 🎯 Exact

Hello kitties: 4/5 = 0.80 🎀

One sentence: new ECS component + observer + store + propagation through drop system

- VFX renderer changes + scenario wiring + tests across 10 files landed solidly in
  Large.

## Systems touched

enemies, vfx

## What Was Done

Implemented three related features from the problem statement:

### 1. Corpses persist longer (300 ms → 3 000 ms)

`DEATH_LINGER_MS` in `src/core/systems/dropSystem.ts` raised from 300 to 3 000 ms
so dead enemy bodies slide to a stop and remain clearly visible on the ground.
Updated `tests/ecs/health.test.ts` timer-expiry loop count (20 → 185 frames) to
match the new duration.

### 2. Blood color as a mob property

**`src/shared/mobDefs.ts`** — added `bloodColor: number` field to `MobDef`
(0xRRGGBB). Default is 0xcc0000 (red). `slime-rat` overridden to 0x22aa44 (green).

**`src/core/components.ts`** — new `BloodColor` component + `bloodColor` store with
`r/g/b: Uint8Array` channels.

**`src/core/world.ts`** — wired `BloodColor` observer via `wireStore()`.

**`src/core/helpers.ts`** — exported `DEFAULT_BLOOD_COLOR = 0xcc0000` and
`setBloodColor(world, eid, hex)` helper. Both `spawnEnemy` and `spawnBehaviorEnemy`
now accept a `bloodColor` parameter (default red) and call `setBloodColor`.

**`src/shared/combat-events.ts`** — added `bloodColor?: number` to `CombatEvent`.

**`src/core/systems/dropSystem.ts`** — reads `BloodColor` via `hasComponent` (not a
non-zero check, so black blood 0x000000 works correctly) and emits it on death
events. Mini slimes on split inherit the parent's packed blood colour.

**`src/game/floor1Scenario.ts`** — imported `setBloodColor`/`DEFAULT_BLOOD_COLOR`;
defined `BLOOD_COLOR_RAT = 0xcc0000` and `BLOOD_COLOR_SLIME = 0x22aa44`. Regular
slime archetypes, mini-slime splits, and both Floor 1 bosses (`ratSlime` stair boss,
`slimeRat` quest boss) are set to green; rat archetypes keep red.

### 3. Blood stains and pools

**`src/shared/render-depths.ts`** — added `bloodPool: 5` to `WORLD_VFX_DEPTH` (sits
below gore splatter particles at depth 10).

**`src/engine/GoreVfx.ts`** — major update:

- `makeColorVariants()` derives 5 shades from a base hex colour using named
  `COLOR_VARIANT_SCALES` constants (documented). Used for both hit splatter and
  death burst particles instead of the hardcoded red `BLOOD_COLORS` array.
- `spawnBloodPool()` creates a persistent `Phaser.GameObjects.Ellipse` at each
  death position; uses `POOL_COLOR_VARIANT_INDEX = 1` (slightly-darker variant) for
  a dried-blood look; alpha fades from 0.55 → 0 over `BLOOD_POOL_LIFETIME_MS =
30 000` ms. Pools are cleaned up in `destroy()`.
- `BloodPool` interface added; `pools[]` array managed alongside `particles[]`.

### 4. Tests

`tests/ecs/blood-color.test.ts` — 9 tests:

- BloodColor component set by `spawnEnemy` (default red) and custom colour.
- BloodColor component set by `spawnBehaviorEnemy` (default + custom option).
- `setBloodColor` channel packing.
- Death event emits `bloodColor` (red default; green for slime enemy).
- Mini-slime split inherits parent blood colour — uses seed loop with
  `assertionRan = true` guard to ensure the assertion branch is reached.
- `DEFAULT_BLOOD_COLOR` constant value.

## Validation

- `npm run verify:fast` — pass (651/651 tests).
- `bash scripts/agent/lab-gate-check.sh` — pass (no new systems; all covered).
- `parallel_validation` — Code Review + CodeQL both passed after addressing 5
  review comments (hasComponent vs non-zero check, named constants, deterministic
  test guard).

## What's Next

- Gore-lab `corpseLingerMs` slider default is still 1000 ms; it could be bumped to
  match the main-game default (3 000 ms) for a more representative preview.
- Blood pools currently use a single ellipse per death; layering 2–3 overlapping
  ellipses of varying size/alpha would look richer.
- Hit events do not yet carry `bloodColor`; only death events do. Future: propagate
  from target entity's `BloodColor` component in `apply-damage.ts`.

## Blockers

None.

## Branch State

- Branch: auto-created by Copilot task agent
- PR: to be opened
- All checks green locally.

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no telemetry section.
