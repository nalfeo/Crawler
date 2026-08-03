# Session Handoff: Floor behavior flags replace hardcoded floor conditionals

## Date

2026-08-03

## Persona

Systems Engineer

## Systems touched

mapgen, weapons, ai-behavior-tree, inventory

## Apples

4🍎 exact

## What Was Done

Took a pass at eliminating floor-specific code by moving hardcoded per-floor
branches out of generic systems and into floor config.

- New `src/shared/floor-behavior.ts`: Zod `behavior` block (all flags default
  `false`) — `spawnRoomIsSafe`, `safeRoomWeaponImmunity`,
  `safeRoomDoorsAutoClose`, `lineOfSightAggro`, `equipmentEconomy`, `bossChests`.
  Wired into `floorManifestDefSchema` and authored explicitly in
  `floor1.manifest.json` / `floor2.manifest.json` to preserve today's semantics.
- New `src/core/floor-behavior.ts`: `getWorldFloorManifest(world)` /
  `getWorldFloorBehavior(world)` — resolves by `world.floorId`, falls back to
  `floor${world.floor}`, then to all-off defaults.
- Converted call sites: `core/safe-space.ts` (`floorId === 'floor2'`),
  `core/systems/{meleeSwing,areaDamage,beam}System.ts` and
  `core/systems/doorSystem.ts` (`world.floor === 1`),
  `core/floor2-equipment-flags.ts` and `game/boss-chest-resolver.ts`
  (`world.floor !== 2`), `game/enemyAISystem.ts` LOS-aggro seam
  (`world.floor === 2`).
- `game/floorScenario.ts` ambient spawning now resolves its enemy pack from the
  manifest `enemyPackId` instead of `world.floor === 2 ? floor2EnemyPack :
  floor1EnemyPack`, and the dead
  `world.floor === 2 ? pack.spawnRadiusMin : FLOOR_1_AMBIENT_MIN_PLAYER_DISTANCE_FT`
  ternary (both branches were the same value) collapsed to `pack.spawnRadiusMin`.

Observed in the real headless pipeline (`npm run test:headless`, not a lab): 28
files / 188 tests green including the Floor 1 legacy weapon-sweep victory and
staircase boss-lock-in seed panels — before and after the refactor the same
seeds are official victories, confirming behavior parity for the safe-room,
door, spawn-pack, and aggro seams. Full unit suite (7031 tests) and
`verify-fast.sh` also green.

## Key Decisions Made

- Flags default to `false` so a new floor opts in explicitly rather than
  silently inheriting Floor 1 or Floor 2 semantics; Floor 1/2 manifests spell
  out all six values.
- Resolver falls back from `floorId` to `floor${world.floor}` so synthetic and
  pre-scenario worlds (which leave `floorId === ''`) keep today's behavior
  without touching every test world.
- Kept the existing `Floor2EquipmentEconomyAccess` message strings so the
  fail-closed contract and its tests are unchanged; only the gate condition
  became config-driven.

## What's Next / Blockers

Remaining floor-specific hot spots, roughly in value order:

1. `src/bootstrap/floor-main-scene-options.ts` — the `floorId === 'floor1'`
   ternary still routes every NPC/stair/spell callback; move these onto
   `ScenarioDefinition` so a floor is manifest + scenario only.
2. `src/game/systems/achievementSystem.ts` — ~8 `world.floor === 2` checks;
   achievements are already split per floor in data, so they should declare
   applicability.
3. `src/shared/floor-manifest.ts` `loadFloorManifest` still string-matches
   `floor1`/`floor2` for the JSON import.
4. `src/game/ai/headless-runner.ts` / `bt-ai-provider.ts` floor2 branches, and
   the `floor2Scenario.ts` monolith (largest, highest risk).

No blockers.

## Retrospective

### Lessons Learned

- Zod 4 rejects `.default({})` on an object schema whose fields all have
  defaults (the default is typed against the *output* type); use
  `.default(() => schema.parse({}))` instead.
- Grepping only for `'floor1'`/`'floor2'` string literals misses the majority of
  floor coupling — the numeric `world.floor === N` form is far more common in
  `src/core` and `src/game`.
- Sequencing the full unit suite before adding new tests made it cheap to prove
  the refactor was behavior-preserving rather than merely compiling.

### Mistakes Made

- Initially planned to also collapse the `floor-main-scene-options.ts` callback
  ternary in the same pass; that touches the boot path for both floors and would
  have pushed this beyond the already multi-system 4🍎 refactor into a larger
  architecture swing. Early signal: the diff started spanning bootstrap wiring
  rather than one repeated pattern — that is the cue to split the session.
- Nearly keyed the behavior resolver on `world.floorId` alone; `createGameWorld`
  defaults it to `''`, so every default test world would have silently lost
  Floor 1 safe-room immunity. Caught by reading `src/core/world.ts` defaults
  before writing the resolver, not by a failing test.

### Opportunities for Future Improvement

- Add a deterministic check that no new `world.floor === <n>` /
  `world.floorId === '<id>'` literal appears in `src/core/**` or `src/game/**`
  outside an allowlist, so this refactor cannot regress.
- The boss stats in `src/shared/floor-config.ts` (`hp: 280`, `fireballCooldownMs:
  5000`) are still hardcoded with a "will be in enemy pack in future" comment —
  a small follow-up can move them into the enemy pack JSON.
