# Session Handoff: AI Runner Lab — Replace level selector with floor selector

## Date

2026-07-05

## Persona

Engineer

## Systems touched

ai-behavior-tree

## Apples

1🍎 exact

## What Was Done

The "level" selector in the AI runner lab (`src/labs/ai-runner-lab/index.ts`) was incorrectly
labelled and wired as a "Start player level" (character level 1–20) input. It was always meant
to be a **floor selector** (which dungeon floor to run).

Changes:

- Removed `startPlayerLevel`, `startLevelApplied`, and `applyStartLevelSystem` (the character-level
  boost logic and its one-shot postSystems hook).
- Removed the `applyStartPlayerLevel` import from `headless-runner.ts`.
- Added `currentFloor = 'floor1'` state variable.
- Added `changeFloor(floorId)` which calls `createFloorMainSceneOptions(floorId)`, updates the
  live `sceneOptions` object in-place via `Object.assign`, then reseeds the scene.
- Replaced `createFloor1MainSceneOptions` / `createFloor1GameConfig` with the multi-floor
  `createFloorMainSceneOptions` / `createFloorGameConfig` variants.
- Added `getAvailableFloorIds` import from `src/shared/floor-registry.ts` to populate the dropdown.
- Replaced the level `<input>` + "Apply + Restart" button with a **Floor** `<select>` dropdown
  - "Apply + Restart" button in the controls panel.
- Updated `ai-level-up-ux-wiring.test.ts` source-guard to assert `createFloorGameConfig` instead
  of the deprecated `createFloor1GameConfig`.

`verify:fast` passes — 3844 tests, 318 test files.

## Key Decisions Made

- `sceneOptions` is mutated in-place via `Object.assign` when changing floors, because
  `MainGameScene` holds a `private readonly options` reference that cannot be replaced after
  construction. This means lab-injected properties (`inputCaptureOverride`, `worldSeed`,
  `autoLevelUpAllocator`, `sessionRecorderFactory`) are preserved since they aren't present
  in the floor manifest object.
- The Floor 1 Debug panel (jump targets, quest helpers) is left as-is; its controls silently
  no-op on floor2 (they check `world.floor1?.objective` which is undefined on floor2). Wiring
  floor2-specific debug helpers is out of scope.

## What's Next / Blockers

- The Floor 1 Debug jump/quest controls are floor1-specific and do nothing on floor2. A follow-up
  could add a floor2-aware debug panel section (or hide the floor1 section when floor2 is selected).
- `autoFloor1ProgressionSystem` is also a no-op on floor2 (`if (!world.floor1) return`). Floor2
  auto-progression (auto-descend, etc.) may be needed for a meaningful floor2 AI run.

## Retrospective

### Lessons Learned

- `MainGameScene` holds options by reference, so in-place mutation of the options object is the
  right mechanism to change floor without recreating the Phaser game instance.
- Source-guard tests (readFileSync + toContain) are the pattern used throughout this codebase for
  cross-layer wiring assertions in the AI runner lab.

### Mistakes Made

None — the change was small and well-scoped.

### Opportunities for Future Improvement

- A floor2 auto-progression system in the AI runner would make floor2 actually runnable end-to-end.
- The Floor 1 Debug section could be conditionally shown/hidden based on `currentFloor`.
