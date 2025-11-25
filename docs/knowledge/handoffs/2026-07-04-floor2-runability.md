# Floor 2 Visual Runability — Handoff

**Session:** floor2-runability  
**Date:** 2026-07-04  
**Branch:** floor2-slice8-scenario-wiring  
**PR:** #761  
**Status:** ✅ Auto-merge armed (SQUASH); all checks green

## Summary

Wired Floor 2 so it can be launched, played through, and completed end-to-end in the visual game. Core work: added staircase state fields, implemented `confirmFloor2StairDescend()` descend flow, updated completion detection in `getFloorRunOutcome`, fixed `updateInteractions()` to show Floor 2 NPCs/stairs, added visual staircase marker and floor-aware completion screen, supported `?floor=<floorId>` URL param, enforced floor state mutual exclusivity.

## Systems touched

mapgen, enemies

## What was done

### 1. Floor 2 state fields (src/core/faction-relations.ts)

- Added 5 optional fields to `Floor2State`:
  - `decapitatedFamilies?: Set<string>` (moved from private `Floor2ExtendedState`)
  - `staircasePos?: { x: number; y: number }`
  - `staircaseSpawned?: boolean`
  - `staircaseUnlocked?: boolean`
  - `staircaseDiscovered?: boolean`
- Removed redundant `Floor2ExtendedState` private type from `floor2Scenario.ts`

### 2. Floor 2 descend implementation (src/game/floor2Scenario.ts)

- Added `confirmFloor2StairDescend(world: GameWorld, playerEid: number): boolean`:
  - Returns `false` if `world.state !== 'playing'` (guards against calling after completion)
  - Returns `false` if `!world.floor2State` or `!staircaseUnlocked` (pre-conditions)
  - Returns `false` if already `staircaseDiscovered` (idempotent)
  - Sets `staircaseDiscovered = true` + `world.state = 'safe_room'`, returns `true`
- Stair-marker interaction radius lives in `src/shared/constants.ts` as `FLOOR2_STAIR_MARKER_RADIUS_FT = 8.0` (single source of truth shared by engine + game; PR #761 review follow-up)
- Wired `confirmFloor2StairDescend` as `onStairDescend` callback in `floor-main-scene-options.ts` for non-floor1

### 3. Completion detection (src/engine/scenes/main-game-scene-helpers.ts)

- Updated `getFloorRunOutcome()`:
  - Floor 2 path: returns `'cleared_floor'` when `floor2State?.staircaseDiscovered === true`
  - Floor 2 path: returns `null` otherwise
  - Floor 1 path: unchanged (checks `world.floor1?.runSummary?.outcome`)

### 4. Visual markers and interactions (src/engine/scenes/MainGameScene.ts)

- Imports `FLOOR2_STAIR_MARKER_RADIUS_FT` from `src/shared/constants.ts` (shared single source of truth; both engine and game layers import from shared)
- **updateObjectiveMarkers()**: Added Floor 2 branch that draws staircase marker:
  - Green circle at `ftToPx(floor2State.staircasePos)`
  - Label "▼ EXIT" below circle
- **updateInteractions()**: Fixed guard that was blocking all Floor 2 interactions:
  - Old: `if (!this.world.floor1) return;` (breaks Floor 2 NPCs + stairs)
  - New: `if (!this.world.floor1 && !this.world.floor2State) return;` (only bail if no floor active)
- **nearStairs computation**: Floor 2-aware proximity check:
  - Floor 2: `dist(playerPos, floor2State.staircasePos) < FLOOR2_STAIR_MARKER_RADIUS_FT` when unlocked
  - Floor 1: existing logic unchanged
- **showFloorCompletionScreenIfNeeded()**: Added Floor 2 branch:
  - Displays "Victory!" banner + "Floor 2 complete!" text
- **Stair descend modal**: Floor 2-aware text:
  - Title: "Victory! Ready to exit?"
  - Body: "Exit the dungeon?"
  - Option: "Yes, exit now"
  - Floor 1 unchanged

### 5. Boot parameter support (src/main.ts)

- Read `?floor=<floorId>` URL param in `bootstrapGame()`:
  - Uses dynamic import: `new URL(window.location.href).searchParams.get('floor')`
  - Validates against floor registry via `getFloorManifest(floorId)` (fails gracefully)
  - Falls back to `'floor1'` with warning if invalid or missing
- Updated to call generic `createFloorGameConfig()` instead of floor1-specific config

### 6. State exclusivity (src/game/floorScenario.ts)

- Added `world.floor2State = null;` in `initializeFloor1Scenario()` after floor initialization
- Ensures Floor 1 and Floor 2 are mutually exclusive (prevents bugs in completion/interaction logic)

### 7. Tests

- `tests/unit/floor2-victory-system.test.ts` (11 tests total; 7 new):
  - ✅ Returns false if world.state !== 'playing'
  - ✅ Returns false if floor2State missing
  - ✅ Returns false if staircaseUnlocked false
  - ✅ Returns false if already staircaseDiscovered (idempotent)
  - ✅ Sets staircaseDiscovered and transitions to safe_room on success
  - ✅ Idempotency verified in separate test
  - Plus 4 original floor2VictorySystem tests (unchanged)
- `tests/unit/main-game-scene-helpers.test.ts` (29 tests total; 3 new):
  - ✅ Returns 'cleared_floor' for Floor 2 when staircaseDiscovered true
  - ✅ Returns null for Floor 2 when staircaseDiscovered false
  - ✅ Returns null for Floor 2 when staircaseDiscovered absent
  - Plus 26 original helper tests (unchanged)
- `tests/game/floor1-game-config.test.ts`:
  - Updated string-match test for `main.ts` to check for `createFloorGameConfig` (was hardcoded to `createFloor1GameConfig`)

### 8. Edge cases fixed (plan review findings)

- **Mixed floor state**: Enforced mutual exclusivity by nulling `floor2State` on Floor 1 init
- **Invalid `?floor=` param**: Validated against registry, falls back to floor1 with warning
- **Idempotency**: `confirmFloor2StairDescend` guards against double-calls

## Testing

### Verification run

- ✅ `npm run verify:fast`: 306 tests pass
- ✅ `npm run verify`: Full suite passes (build, lint, type-check, tests, PR prereqs all green)
  - Format & Labs: ✅
  - Types & Lint: ✅
  - Unit tests: 3663 tests pass
  - Integration tests: 85 tests pass
  - PR prerequisites: ✅ valid review ledger

### Review harness

- **Plan review** (gpt-5.4, separate-model rubber-duck agent):
  - Identified 2 edge cases (mixed floor state, invalid URL param)
  - Both fixed with code + tests
  - Review ledger valid ✅

## Observer notes (observe before done)

**Visual game** (`npm run dev`):

- Floor 2 can be booted with `?floor=floor2` URL param
- Staircase marker visible as green circle with "▼ EXIT" label when spawned/unlocked
- Stair proximity detected correctly; modal appears ("Victory! Ready to exit?")
- Descending staircase sets `world.state = 'safe_room'` and triggers completion screen
- Floor 1 initialization on same world correctly nulls floor2State (mutual exclusivity enforced)

**Headless runner** (AI):

- Floor 2 AI still 0% win rate (expected; AI has no den-unlock/boss-targeting logic)
- Governor sweep data: Floor1 98.3% (59/60), Floor2 0% (0/20 — expected at this stage), Combined 73.75%

**Unit test coverage**:

- All new tests pass; old tests unaffected
- `confirmFloor2StairDescend` all guard cases + happy path covered
- `getFloorRunOutcome` Floor 2 branches covered (discovered=true/false/absent)
- State exclusivity tested

## Known gaps (not blockers; follow-on work)

1. **Floor 2 AI objective support**: AI has no den-unlock or boss-targeting logic → 0% win rate. Separate work item.
2. **Floor 1 → Floor 2 scene transition**: Currently stairs just show completion screen, not a real visual transition. Devs must use `?floor=floor2` to test.
3. **HUD wiring for Floor 2**: Relationships widget and minimap territory tint not yet deterministic E2E tested.

## Apple estimate

**Declared:** 🍎🍎  
**Actual:** 🍎🍎  
**Verdict:** On-estimate

Multi-file wiring across engine/game/bootstrap layers with new tests; no algorithmic complexity; layer-boundary management required (engine cannot import from game, so the shared stair-marker radius lives in `src/shared/constants.ts` as `FLOOR2_STAIR_MARKER_RADIUS_FT`). Scope well-contained at ~250 LOC across 9 files. Review harness identified 2 edge cases, both fixed with code + tests.

## Merge & next steps

- **PR #761** auto-merge armed (SQUASH, nalfeo)
- ✅ All checks green; 0 unresolved review threads
- Will self-merge once CI completes
- **Next parallel work**: Floor 2 AI objective support (den-unlock, boss-targeting) to move win rate from 0% toward ≥90%
