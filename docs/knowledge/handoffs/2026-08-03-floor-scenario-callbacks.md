# Session Handoff: Floor NPC/stair callbacks move onto ScenarioDefinition

## Date

2026-08-03

## Persona

Systems Engineer

## Systems touched

floor-config, quests, doors

## Apples

2🍎 exact

## What Was Done

Follow-up item #1 from `2026-08-03-floor-behavior-config.md`: removed the
`floorId === 'floor1'` ternaries that routed every NPC/stair callback in
`src/bootstrap/floor-main-scene-options.ts`, so a floor is now manifest +
scenario only.

- `src/game/scenarioDefinitions.ts`: `ScenarioDefinition` gained optional
  `onStairDescend`, `nextFloorId`, and `npcs` (new `ScenarioNpcCallbacks` with
  `shopkeeper` / `tutorialGoon` / `spellQuestGiver` / `broker`). The callback
  shapes are declared in the game layer (types from `src/shared/quest-types.ts`)
  because `src/game/` must not import from `src/engine/`.
- Floor 1 registers the quest-giver trio, `confirmFloor1StairDescend`, and
  `nextFloorId: 'floor2'`; Floor 2 registers the broker and
  `confirmFloor2StairDescend`.
- `createFloorMainSceneOptions` now reads `scenario.onStairDescend`,
  `scenario.npcs?.*`, and builds the in-process floor-transition callback from
  `scenario.nextFloorId` (also used for the `?floor=` URL param) instead of
  hardcoding `'floor2'`. The file contains no floor-id literal branches.

Observed in the real headless pipeline (`npm run test:headless`, not a lab): 28
files / 188 tests green, including the Floor 1 legacy weapon-sweep victory seeds
and the staircase/boss panels that exercise the stair-descend and floor 1→2
transition seams — same official victories before and after. Unit suite (506
files / 7038 tests), integration suite (28 files / 224 tests), typecheck and lint
all green.

## Key Decisions Made

- `selectSpellFromBossBattle`, `getSpellRewardOptions`, `allocateStatPoints`,
  `preSystems`, and `postSystems` stay unconditional in the bootstrap file —
  they had no floor branch today, and moving them would have changed behavior
  for Floor 2 rather than just removing a conditional.
- Transition is expressed as `nextFloorId` rather than a per-scenario closure so
  the carryover capture, URL rewrite, and seed/run-key plumbing stay in one
  place in bootstrap.
- Kept the engine-side option name `onFloor1Cleared` unchanged; renaming it is a
  separate rename across `MainGameScene` and its labs/tests.

## What's Next / Blockers

Remaining floor-specific hot spots from the parent handoff, unchanged in value
order:

1. `src/game/systems/achievementSystem.ts` — ~8 `world.floor === 2` checks;
   achievements are already split per floor in data, so they should declare
   applicability.
2. `src/shared/floor-manifest.ts` `loadFloorManifest` still string-matches
   `floor1`/`floor2` for the JSON import.
3. `src/game/ai/headless-runner.ts` / `bt-ai-provider.ts` floor2 branches, and
   the `floor2Scenario.ts` monolith (largest, highest risk).
4. Rename the engine option `onFloor1Cleared` → floor-agnostic
   (`onFloorCleared`) now that its wiring is config-driven.

No blockers.

## Retrospective

### Lessons Learned

- The presentation-layer option shapes could be mirrored in the game layer
  without a layer violation because the underlying types (`ShopkeeperStage`,
  `NpcQuestIndicatorState`) already live in `src/shared/` — checking where a type
  lives is what decides whether an interface can move down a layer.
- Splitting this out of the parent 4🍎 session (as that handoff recommended)
  kept the diff to two source files plus a test, exactly as predicted.

### Mistakes Made

- None material; the one near-miss was moving `selectSpellFromBossBattle` into
  the scenario, which would have silently dropped the boss-reward modal wiring
  on Floor 2 since only Floor 1 has authored reward spells.

### Opportunities for Future Improvement

- The deterministic "no new `world.floor === <n>` literal" check proposed by the
  parent handoff would now also be worth extending to `floorId === '<id>'`
  literals in `src/bootstrap/**`, which this session just cleared.
