# Floor 3 set pieces — Studio motifs + Final Four arena

## Systems touched

mapgen, enemies, quests

## Summary

- Added seven affinity-specific Floor 3 Studio motifs plus a Final Four arena to `src/shared/data/set-pieces.json`, with the affinity → set-piece mapping in `src/shared/data/floor3/set-pieces.ts`.
- Wired `initializeFloor3Scenario` to carve/stamp the authored set piece for each selected Studio and for the Final Four, recording `setPieceId` / `setPieceCarved` on the Floor 3 encounter state.
- Fixed roster spawn placement: `carveSetPieceRoom` drops a room's `interiorCells` mask, which previously collapsed every Companion of a carved Studio onto the room centre. `collectFloor3RosterSpawnTiles` now fans spawns across distinct passable tiles, falling back to a bounds-inset scan **only** when the mask yields no usable tile so an irregular cave mask stays authoritative.
- Un-exported `FLOOR3_STUDIO_SET_PIECE_BY_AFFINITY` and `floor3StudioUnlockGoalId` (both had no production callers outside their own module), clearing the `check:test-only-exports` and `lint:dead-code` gates.

## Validation

- Targeted suites: `npx vitest run tests/unit/floor3` (59 tests) — includes the two new regression assertions, both verified failing against the pre-fix code:
  - carved Studio room spawn coordinates: 1 distinct (stacked) → 4 distinct (fanned).
  - irregular-mask room: spawns leaked outside `interiorCells` → all spawns on the mask.
- Gates: `npm run typecheck`, `npm run lint`, `npm run format`, `npm run check:test-only-exports` (with `GITHUB_BASE_SHA` set to the PR base), `npm run lint:dead-code`, `npm run verify:pr-prereqs`.
- Set-piece composition gate: `npm run setpiece:score -- <the 8 new ids>` → **8/8 layouts pass, 12/12 checks each**.
- Security hygiene: `runtime-tools-secret_scanning` over all changed files — no secrets detected.

## Unresolved issues

- The Final Four roster still falls back to the map-centre spiral scan (`findFloor3ArenaTiles`) when no spare territory room exists; a dedicated arena chamber is spec slice 9's deliverable.

## Recommended next steps

- Slice 9: carve a real Final Four arena chamber in the Floor 3 generator so the spiral-scan fallback can be retired.
- Consider an occupancy-aware spawn tile picker (like `resolveFreeNpcTileInRoom` in `floorScenario.ts`) if Studio rosters grow beyond the tiles a small carved room can offer.

## Gotchas for the next session

- `scripts/agent/health/test-only-exports.ts` scopes itself to files changed against the PR base. Locally it defaults to a working-tree diff and will flag exports the branch did not introduce; run it with `GITHUB_BASE_SHA=<pr base sha>` to reproduce CI.
- `npm run review:grade -- prompt` refuses to emit a packet when the diff exceeds 200k chars — an authored data blob like `set-pieces.json` blows past that on its own, so the independent grader has to read the diff from the repo directly and the grade is recorded with `--head-sha`.
