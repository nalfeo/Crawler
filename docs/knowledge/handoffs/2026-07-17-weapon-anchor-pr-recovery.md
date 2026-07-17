# Weapon Anchor PR Recovery

**Date:** 2026-07-17  
**PR:** #1248 — feat: add generic weapon anchors to mob sprite metadata, editor, and runtime resolver  
**Commits:** 50ac476, ad39cb2  
**Session type:** PR recovery (8 review thread blockers)

## Systems touched

sprite-pipeline, engine, game, shared, devtools

## What changed

Addressed all 8 `copilot-pull-request-reviewer` findings from PR #1248:

### Thread 1 — Mirroring math (`src/shared/generated-assets.ts`)
Old logic mirrored the weapon pixel coordinate (`frameW - 1 - wpX`) before computing the relative offset, producing an asymmetric result. New logic computes the relative offset first (`relX = wpX - cogX`), then negates it when mirroring is needed: `offsetX = (needsMirror ? -relX : relX) / frameW * spriteFt`. Also correctly handles left-authored art facing right.

### Thread 2 — Engine mutation violation (`src/engine/PhaserBridge.ts`)
Removed ~45 lines of per-entity per-frame `world.entityWeaponAnchors` writes from `PhaserBridge.sync()`. Instead, `PhaserBridge` sets `world.generatedSpriteRegistry` once on registry change and clears the cache. Consumers lazily resolve via `getEntityNormalizedWeaponAnchor` in `src/shared/generated-assets.ts` (game layer).

### Thread 3 — World contract facing direction (`src/core/world.ts`)
Changed `world.entityWeaponAnchors` from `Map<number, {x,y}>` to `Map<number, NormalizedWeaponAnchor>` where `NormalizedWeaponAnchor = {relX, relY, artFacing}`. Mirror condition: `artFacing !== (facingRight ? 'right' : 'left')`.

### Thread 4 — Physics vs visual dimensions
Replaced `world.stores.sprite.width/height` reads (ADR 0044 violation, physics body 2ft) with `DEFAULT_GENERATED_VISUAL_WIDTH_FT = 3.2` (64px × 0.4 renderScale / 8px/ft). Constant lives in `src/shared/generated-assets.ts`.

### Thread 5 — Missing editor UI (`src/devtools-main.ts`)
Added "Weapon anchor x/y" input row, `manualWeaponAnchorOverride` / `pendingManualWeaponAnchorClear` state, `syncManualWeaponAnchorFromInputs`, hydration from `summary.postprocessOverrides.manualWeaponAnchor`, and `weaponAnchor` in postprocess body.

### Thread 6 — Snapshot/summary persistence (`scripts/sprites/rerun.ts`, `postprocess-overrides.ts`, `run-artifacts.ts`)
Added `manualWeaponAnchor` to `EffectivePipelineSnapshot`, `RunSummary.postprocessOverrides`, and all callers (`rerun.ts`, `run-full.ts`).

### Thread 7 — Missing consumer tests
Added 3 tests to `tests/game/enemy-projectile-telegraph.test.ts`: facing right, left-facing mirror, and no-anchor fallback.

### Thread 8 — Missing pipeline tests
Added:
- `tests/unit/sprites/sidecar-server.test.ts`: set/clear via `/weapon-anchor` route
- `tests/unit/sprites/approve.test.ts`: sidecar ingestion, `{ cleared: true }`, absent-sidecar
- `tests/integration/sprites/sidecar-rerun.test.ts`: round-trip persistence and clear via postprocess body

### Post-review fix — hardcoded 'enemy' type
`getEntityNormalizedWeaponAnchor` was calling `generatedBriefIdForEnemy('enemy', appearanceKey)` with a hardcoded generic type. Replaced with `GENERATED_BRIEF_BY_APPEARANCE_KEY[appearanceKey]` direct lookup since all generated-sprite entities carry an appearance key and the type-based fallback is unavailable in the `WeaponAnchorWorld` contract.

## Key files

- `src/shared/generated-assets.ts` — `NormalizedWeaponAnchor`, `computeNormalizedWeaponAnchor`, `getEntityNormalizedWeaponAnchor`, `DEFAULT_GENERATED_VISUAL_WIDTH_FT`, `WeaponAnchorWorld`, `GENERATED_BRIEF_BY_TYPE` (moved from engine)
- `src/core/world.ts` — `generatedSpriteRegistry`, updated `entityWeaponAnchors` type
- `src/engine/PhaserBridge.ts` — registry handoff to world; removed per-frame anchor mutation
- `src/core/systems/enemyTelegraph.ts`, `src/game/enemyAISystem.ts` — lazy anchor resolution
- `scripts/sprites/postprocess-overrides.ts`, `run-artifacts.ts`, `rerun.ts`, `run-full.ts` — snapshot types
- `src/devtools-main.ts` — weapon anchor editor UI

## Test coverage

4 test files modified/added, 8 new integration test cases, ~20 new unit test cases. All pass.
