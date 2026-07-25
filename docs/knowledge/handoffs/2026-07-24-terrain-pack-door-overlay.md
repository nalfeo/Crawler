# Handoff: Wire terrain-pack doorSet into engine door overlay path

## Systems touched

mapgen, hud-ux

## Summary

Wired `MainGameScene` door overlay rendering to consume the active floor terrain pack `doorSet`
for open/closed × horizontal/vertical door variants. Floor 2 now resolves and renders
`industrial-cave` door textures through the real engine path, while fallback behavior for non-pack
floors remains unchanged (generated/Kenney/color chain).

## What changed

- `src/engine/sprites/door-visuals.ts`
  - Extended `resolveDoorRenderMode` with optional `packDoorTextureKey` precedence.
  - Added new render mode branch: `{ kind: 'pack', textureKey }`.
- `src/engine/scenes/MainGameScene.ts`
  - Threaded floor manifest `terrainPackId` into `buildTerrainLayer(...)`.
  - In `updateDoorOverlay()`, resolved door orientation + pack variant via shared helpers
    (`resolveDoorOrientationFromFlanks`, `resolveDoorPoolVariant`), then rendered pack textures
    when present/loaded.
  - Added pack-specific render summary counters (`closedPackCount`, `openPackCount`) for probe/e2e
    observability.
- `src/shared/data/floors/floor2.manifest.json`
  - Set `"terrainPackId": "industrial-cave"`.
- Probe + tests
  - `src/labs/main-scene-probe-lab/index.ts`: exposed new pack door summary fields.
  - `tests/unit/door-visuals.test.ts`: added pack-precedence resolver assertions.
  - `tests/unit/main-game-scene-door-pack-wiring.test.ts`: deterministic engine-path wiring guard.
  - `tests/e2e/floor2-pack-door-overlay.test.ts`: real `MainGameScene` Floor 2 guard asserting
    closed doors render via pack textures.
  - `tests/e2e/generated-door-overlay.test.ts`: added `closedPackCount === 0` Floor 1 behavior guard.
  - `tests/unit/floor-manifest-terrain-pack.test.ts`: updated Floor 2 manifest expectation.

## Observe-before-done artifact

- Added deterministic real-scene guard `tests/e2e/floor2-pack-door-overlay.test.ts` using
  `main-scene-probe-lab` with `?floor=floor2`, asserting:
  - `renderableClosedCount > 0`
  - `closedPackCount === renderableClosedCount`
  - `closedGeneratedCount + closedKenneyCount + closedColorCount === 0`

## Verification

- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-24-terrain-pack-door-overlay.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ❌ initially (missing handoff/ledger), expected and fixed in this diff.
- Local runtime/tooling verification currently blocked in this environment due dependency install
  network failures (`vitest` unavailable, `npm ci` unable to reach package host), so
  `verify:fast` / targeted tests could not be executed to completion here.

## Unresolved / follow-up

- Required issue plan comment attempt failed with GitHub auth in this environment (`gh issue comment`
  returned HTTP 403). If needed, repost the exact plan text from session logs once credentials are
  available.
