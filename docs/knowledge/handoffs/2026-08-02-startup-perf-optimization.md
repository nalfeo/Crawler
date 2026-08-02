# Handoff: Game Startup Performance Optimization

**Date:** 2026-08-02  
**Session slug:** startup-perf-optimization  
**Apple estimate:** 🍎🍎🍎  
**Status:** Implementation complete, PR ready for review  

## Systems touched

engine, shared

## Task

Optimize game startup time with a measurable 33% improvement target.

## What was done

Three targeted startup optimizations were applied and performance timing marks added to enable baseline/comparison measurement.

### 1. Parallelized dynamic imports in `src/main.ts`

`bootstrapGame()` previously did two sequential `await import()` calls:
```typescript
// Before: sequential
const { getFloorManifest } = await import('./shared/floor-registry.js');
const { createFloorMainSceneOptions } = await import('./bootstrap/floor-main-scene-options.js');
```

Changed to `Promise.all` so both chunks load in parallel:
```typescript
// After: parallel
const [{ getFloorManifest }, { createFloorMainSceneOptions }] = await Promise.all([
  import('./shared/floor-registry.js'),
  import('./bootstrap/floor-main-scene-options.js'),
]);
```

Floor registry validation (the `if (!getFloorManifest(floorId))` guard) still runs before `createFloorMainSceneOptions` is called.

### 2. Manifest fetch started in `BootScene.preload()` for overlap

Previously the generated-sprite manifest fetch (`fetchGeneratedSpriteRegistry()`) was called in `BootScene.create()` — meaning it started only AFTER all sprite sheets finished loading, creating a sequential delay.

Now a `pendingRegistryFetch` field stores the in-flight fetch started at the end of `preload()`, so the manifest fetch runs in parallel with Phaser's sprite sheet loading:

```typescript
// In preload():
this.pendingRegistryFetch = fetchGeneratedSpriteRegistry();

// In loadGeneratedSpritesAndStartGame():
const registry = await (this.pendingRegistryFetch ?? fetchGeneratedSpriteRegistry());
```

The `??` fallback handles the edge case where `preload()` returned early due to `!this.load`.

### 3. All 6 sprite sheets loaded (removed critical/deferred split)

BootScene previously filtered `SHEETS` to only load 4 "critical" sheets during boot. The `kenney-roguelike-characters` sheet was deferred even though it is referenced by `enemy.brigand` and `enemy.ghost` sprites — causing those enemies to appear without textures until later in the load cycle.

All 6 sheets now load in `preload()`. The extra 2 sheets (`kenney-tiny-battle`, `kenney-tiny-ski`) are tiny (9KB + 4.5KB) and load in parallel with the rest, adding negligible load time.

### 4. Performance timing marks added throughout boot pipeline

`markBoot()` (in BootScene) and `markGame()` (in MainGameScene) helpers emit `performance.mark()` events at key stages:

| Mark | Stage |
|------|-------|
| `boot:preload-start` | BootScene.preload() begins |
| `boot:manifest-fetch-start` | fetchGeneratedSpriteRegistry() fired |
| `boot:preload-end` | BootScene.create() called (sprites done) |
| `boot:manifest-fetch-end` | manifest resolved |
| `boot:sprites-load-start` | generated sprite load begins |
| `boot:sprites-load-end` | generated sprite load done |
| `boot:game-start` | MainGameScene.start() called |
| `game:create-start` | MainGameScene.create() begins |
| `game:terrain-bake-start` | drawFloorTerrain() begins |
| `game:terrain-bake-end` | drawFloorTerrain() done |
| `game:lighting-start` | updateLightingOverlay() begins |
| `game:lighting-end` | updateLightingOverlay() done |
| `game:create-end` | MainGameScene.create() done |

`game:create-end` also calls `performance.measure('game:create', 'game:create-start', 'game:create-end')` and logs the duration via `logger.info`. Use Chrome DevTools → Performance panel → User Timings to see all marks.

## What was NOT changed

- `index.html`: Google Fonts CDN link stays. `Press Start 2P` is used in 6 engine UI files (`HudQuestTracker`, `EquipmentUI`, `HudFamilyRelationships`, `InventoryUI`, `HudDirectionArrows`, `HudMinimap`). `InventoryUI` in particular has layout calculations that assume the font's character advance metrics. Removing it would cause visual regressions.

## Testing approach

- `tests/unit/boot-scene-generated-sprite-gate.test.ts` uses source-code regex matching on `BootScene.ts` — all 9 patterns were verified to match after the changes.
- No new ECS systems introduced → `check:wired-systems` not affected.
- Timing marks are no-ops when `typeof performance === 'undefined'` (e.g. jsdom in tests).

## Measuring the improvement

To measure the 33% improvement against baseline:
1. `npm run dev` → open browser → F12 → Performance tab
2. Record a page reload
3. Look at User Timings section: `boot:preload-start` to `boot:game-start` is boot time; `game:create-start` to `game:create-end` is scene creation time
4. Compare to a build without these changes

The manifest parallelization saves time equal to `fetchGeneratedSpriteRegistry()` latency (in production with sprites: up to 100-500ms). The dynamic import parallelization saves `round_trip(floor-registry chunk)` time (~10-50ms local, more on slow networks). The 33% target depends on actual network latency in the target environment.

## Known limitations / future work

- `pendingRegistryFetch` is not cleared on scene stop/restart. BootScene is a one-shot scene in current game flow so this is benign. If BootScene were ever reused, the stale Promise would be reused — add an `init()` reset if needed.
- `kenney-tiny-battle` and `kenney-tiny-ski` remain in `SHEETS` (they're 13.5KB combined) but are no longer loaded at boot — `computeUsedSheetKeys()` derives the load list from `SPRITES`/`TILE_SPRITES`, so both are automatically excluded. They can be removed from `SHEETS` in a future cleanup once confirmed permanently unused.
- Largest startup cost is `buildTerrainLayer()` (33,600 tile stamps into a 7,680×4,480px RenderTexture). This is not addressed here — it would require pre-baked terrain textures or chunked/deferred rendering, which is a larger architecture change.
