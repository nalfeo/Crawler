# Handoff: Lab Feedback Bundle

**Date:** 2026-06-09  
**Branch:** `nalfeo/lab-feedback-bundle`  
**Commit:** `30a8be7`

## Summary

Implemented all 5 grouped lab UX feedback items for collision-lab and pathfinding-lab.

## Work Completed

### collision-lab (`src/labs/collision-lab/index.ts`)

**#1 — Bowling ball weapon added**

- Added `'bowling-ball'` to `ProjectileType` union
- Added `WallHit` type `{ t, normalX, normalY }` for AABB slab intersection
- Added `raycastRectHit(origin, delta, wall, radius)` for surface normal detection
- Added `bouncesLeft` + `pierceThrough` fields to `ProjectileState`
- Added `BOWLING_BALL_BOUNCES = 6` constant
- Added profile: speed 340, radius 16, maxDistance 1400, color `#64748b`
- Added `advanceBouncingProjectile`: sub-step loop with dot-product reflection, 0.92 energy decay, 0.5px wall nudge
- Bowling ball pierces through all mobs (`pierceThrough: true`)
- Render: slate-gray disc with 3 finger holes, bounce counter label, outer stroke ring
- GUI: `shotOptions` now includes `'Bowling Ball': 'bowling-ball'`

**#2 — Room switching (was already done)**

- `ROOM_PRESETS` array with 3 layouts + GUI control already existed. No changes needed.

### pathfinding-lab (`src/labs/pathfinding-lab/index.ts`)

**#3 — Multiple room layouts**

- 4 presets in `LAB_MAP_PRESETS` array:
  - `two-pillars`: Original layout (center wall/door, left & right pillars)
  - `open-field`: Bare room, border walls only
  - `snake-walls`: Two horizontal snake barriers with offset gaps
  - `box-maze`: Center divider + asymmetric box obstacles in each half
- Each preset owns its `mapW`, `mapH`, `playerStart`, `enemyStart`, `doorTile`, and `buildMap(doorOpen)` factory
- Canvas size synced dynamically to active preset dimensions
- GUI "Room Layout" dropdown: `onChange(() => resetWorld())`

**#4 — Dynamic path visualization per mob**

- `labSettings.showPaths` boolean, toggled via GUI "Show Mob Paths"
- In `draw()`: when enabled, calls `findTilePath` for each mob toward the player
- Renders dashed polyline in each mob's assigned color with 55% opacity
- Uses correct `PATH_TRAVERSAL.FLYING` for flying mobs, `PATH_TRAVERSAL.GROUND` otherwise

**#5 — Mob spawn controls**

- `mobEnabled: Record<string, boolean>` and `mobCount: Record<string, number>` flat settings objects
- GUI "Mob Spawn" folder with per-type sub-folders (Stupid, Navigator, Flanker, Flying)
- Each sub-folder: Enabled toggle + Count slider (0–5), both `onChange(() => resetWorld())`
- `MobSpec` array defines `persona`, `traversalMode`, `isFlying`, `flankDistance`
- `SPAWN_OFFSETS` array staggers multi-mob spawns deterministically
- `mobs: MobInstance[]` tracks `{ eid, label, color, isFlying }` for draw and path viz

## Verification

```
✅ verify:fast: 103 test files, 1017 tests — all passed
```

## Files Changed

- `src/labs/collision-lab/index.ts` (+173 lines)
- `src/labs/pathfinding-lab/index.ts` (+460 net lines, full rewrite)

## Next Steps (if any)

- Could add integration tests for pathfinding lab presets if desired
- Could expose flankDistance as a GUI slider in the Flanker sub-folder
