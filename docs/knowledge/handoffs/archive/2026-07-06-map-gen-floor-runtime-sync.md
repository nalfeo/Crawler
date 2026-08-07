# Map Gen Floor Runtime Sync

## Date

2026-07-06

## Persona

Producer

## Systems touched

mapgen, devtools

## Apples

3🍎 estimated, 3🍎 actual (exact)

## What Was Done

Rewired constrained Floor 1 / Floor 2 map-gen lab generation to call the real gameplay scenario initializers instead of reconstructing floor defaults and NPC/special-room placement from manifests. Added a shared runtime-preview helper for constrained floors, switched the lab overlays/tooltips to read NPCs, spawners, special rooms, family names, and door-lock criteria from runtime world state, and fixed the initial lil-gui display sync so the visible biome/size controls match the constrained settings on first load.

Observed in the live lab at `lab.html?lab=map-gen-lab` — after the fix, Floor 1 now renders as `basic_underground` at `240x140`, and the visible controls show `floor1`, `basic_underground`, width `240`, and height `140`. The focused runtime-preview test also asserts that Floor 1 NPCs no longer land in the player's spawn room.

## Key Decisions Made

- Kept freeform generation on the existing `buildConfig()` path and only branched constrained mode into the real floor scenario init path.
- Added a small `runtime-preview.ts` helper instead of burying world bootstrap/scenario init inside the lab UI file.
- Used runtime `doorLockConfigs`, `world.npcs`, `Spawner`, and floor objective state as the overlay source of truth instead of preserving the old synthetic marker math.

## What's Next / Blockers

No blockers. The branch is ready for the next review / PR step.

## Retrospective

### Lessons Learned

- The original bug was partly a data-source bug and partly a UI-sync bug: the map was wrong because the lab was approximating runtime state, and the controls were misleading because persisted lil-gui values were not refreshed after constrained defaults applied.

### Mistakes Made

- The first pass assumed manifest defaults were close enough to gameplay for Floor 1, but the actual runtime path hardcodes `basic_underground` and refines NPC/objective placement after map generation.

### Opportunities for Future Improvement

- Expose a tiny debug surface from the lab runtime preview so browser automation can read hover-target data directly instead of inferring state through DOM text.
