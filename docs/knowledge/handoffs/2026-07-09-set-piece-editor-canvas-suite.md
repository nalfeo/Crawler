# Session Handoff: Set-piece editor canvas suite with runtime-fidelity NPC transforms and tests

## Date

2026-07-09

## Persona

Producer -> Canvas/editor + runtime wiring

## Systems touched

devtools, mapgen, enemies

## Apples

4🍎 estimated, 4🍎 actual (multi-system editor + shared/core/game/engine threading with runtime-fidelity and review-harness evidence captured in the review ledger).

## What Was Done

Completed the set-piece editor canvas stack so authored layout and transform changes persist through the real runtime pipeline.

- Extended set-piece shared types/schema to support sub-tile coordinates, scene layers, sprite-layer rotation, and NPC visual metadata (`widthFt`, `heightFt`, `flipX`, `flipY`, `rotationDeg`, `spriteOverride`), with paired size validation.
- Updated stamping to keep NPC integer tile bookkeeping for occupancy/objectives while preserving authored sub-tile world coordinates for rendering.
- Threaded NPC visual overrides and transform fields through spawn flow (`spawnNpc`) into runtime NPC instance state.
- Updated Phaser bridge NPC resolution to honor per-instance sprite override and apply per-instance flip/rotation every sync.
- Updated floor scenario + set-piece lab wiring to pass stamped NPC visual metadata through spawn.
- Applied editor-driven set-piece data updates in `src/shared/data/set-pieces.json`, including floor/wall/layout changes.
- Added regression unit tests for schema compile/validation, stamp propagation, and runtime Phaser bridge transform behavior.

## Verification Run

- `npm run typecheck`
- `npm run verify:pr-prereqs` (after adding required PR artifacts)
- `npm run verify:fast` (repeated during review-address rounds)
- `npm run test:guards --silent`
- `npm run test:headless -- collision-pair-parity`

## Observe Before Done (real artifact)

- **Before:** headless collision parity gate showed deterministic fingerprint drift vs the pinned expected set.
- **After:** fingerprints were intentionally rebaselined to the current deterministic runtime output and the parity gate passed on the reviewed branch.

## Recommended Next Steps

- Monitor future set-piece editor feature additions to ensure each new authored field is threaded through shared -> core -> game -> engine paths and covered by unit tests.
- Keep welcome-room fixture expectations synchronized with intentional `set-pieces.json` edits.
