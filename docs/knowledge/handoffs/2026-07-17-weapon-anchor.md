# Handoff: Add generic weapon anchors to mob sprite metadata and editor

**Date:** 2026-07-17  
**Session slug:** weapon-anchor  
**Closes:** #1247  
**Apples:** 3🍎 estimated → 3🍎 actual (exact)  
**PR:** #1248 (or open)

## Systems touched

sprites, enemy-ai, engine-bridge, world-state

## What was done

Added optional `weapon` anchor to generated sprite metadata so mob sprites can have explicit weapon-attachment/muzzle points rather than always falling back to the ECS entity pivot for projectile/melee attachment origins.

### New contract

- Sprite manifest `anchors.weapon` field (optional): pixel coordinates authored by the sprite editor.
- `GeneratedSpriteEntry.weaponAnchor` (optional): runtime registry field; absent when not authored.
- `resolveWeaponAnchorWorldPos` (pure function in `src/shared/generated-assets.ts`): converts pixel coords to world-feet offset given entity position + sprite dimensions. Handles right-art mirroring for left-facing entities.
- `GameWorld.entityWeaponAnchors: Map<number, {x,y}>`: populated by PhaserBridge with canonical right-facing offset; read by game-layer systems (enemyTelegraph, enemyAISystem); callers negate X for left-facing.

### Pipeline flow (end-to-end round-trip)

1. Editor calls `POST /api/runs/:briefId/:runId/weapon-anchor` → persists `weapon-anchor.json` override.
2. `POST /api/runs/:briefId/:runId/postprocess` (or rerun) reads the override → writes `processed/NN.anchor.weapon.json` per variant.
3. `approve.ts` reads `NN.anchor.weapon.json` → populates `ManifestEntry.anchors.weapon`.
4. `toRegistryEntry` reads `anchors.weapon` → sets `GeneratedSpriteEntry.weaponAnchor`.
5. PhaserBridge reads `weaponAnchor` each frame → computes offset via `resolveWeaponAnchorWorldPos(entry, 0, 0, ...)` → writes `world.entityWeaponAnchors.set(eid, offset)`.
6. Entity destroy cleanup: `world.entityWeaponAnchors.delete(eid)`.
7. `enemyTelegraph.ts / enemyAISystem.ts` read `world.entityWeaponAnchors.get(eid)` to apply offset; negate X when `velocity.x < 0`.

### Facing / mirroring design

- All generated enemy art faces **right** by default (`facingDirection: 'right'`).
- The weapon anchor pixel coordinate is stored in canonical right-facing form.
- Render layer flips sprite when `velocity.x < 0`; game systems apply matching negate-X logic.
- `resolveWeaponAnchorWorldPos` mirrors X (`framePixelWidth - 1 - wpX`) when `entry.facingDirection === 'right'` and `facingRight === false`.
- `entityWeaponAnchors` stores canonical right-facing offset; callers handle direction: `facingRight ? wa.x : -wa.x`.

### Cleared-anchor semantics

- `NN.anchor.weapon.json` with `{ cleared: true }` = editor explicitly cleared a previously authored anchor → `ManifestEntry.anchors.weapon = null`.
- Absent file = never authored → `undefined` (falls back to entity pivot at runtime).
- Explicit `null` in manifest is preserved so round-tripped data doesn't silently re-add.

### Sidecar hydration

- `hydrateRunDirForApproveFromStore` now includes `NN.anchor.weapon.json` in `candidateKeys` so approval from cloud store is complete.

## Files changed

| File                                                                        | Change                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/sprite-anchor.ts`                                               | `weapon?` in `SpriteAnchors`; `resolveSpriteAnchors` passes through without defaulting                                                                                                    |
| `src/shared/generated-assets.ts`                                            | `weapon` in `anchorsSchema`; `weaponAnchor?` in `GeneratedSpriteEntry`; `toRegistryEntry` populates it; added `resolveWeaponAnchorWorldPos`                                               |
| `scripts/sprites/approve.ts`                                                | `weapon?` in `ManifestEntry.anchors`; reads `NN.anchor.weapon.json`; added `resolveWeaponAnchorSidecar` helper                                                                            |
| `scripts/sprites/postprocess-overrides.ts`                                  | `MANUAL_WEAPON_ANCHOR_KEY`; `ManualWeaponAnchorOverride`; `readManualWeaponAnchor`, `writeManualWeaponAnchor`, `removeManualWeaponAnchor`                                                 |
| `scripts/sprites/run-pipeline.ts`                                           | Writes `NN.anchor.weapon.json` sidecar per variant; clears when no anchor applicable                                                                                                      |
| `scripts/sprites/rerun.ts`                                                  | Threads `manualWeaponAnchor` through rerun pipeline; persists/clears on reset                                                                                                             |
| `scripts/sprites/sidecar/server.ts`                                         | Parses `body.weaponAnchor` in postprocess route; new `POST /weapon-anchor` route; hydration candidateKeys updated                                                                         |
| `src/core/world.ts`                                                         | `entityWeaponAnchors: Map<number, {readonly x,y}>` in `GameWorld` interface; initialized in `createGameWorld`                                                                             |
| `src/core/systems/enemyTelegraph.ts`                                        | `startEnemyProjectileTelegraph` applies weapon anchor offset with velocity-based facing                                                                                                   |
| `src/game/enemyAISystem.ts`                                                 | Immediate-fire path in `tryFireEnemyProjectile` applies weapon anchor offset                                                                                                              |
| `src/engine/PhaserBridge.ts`                                                | Populates `entityWeaponAnchors` from generated sprite entry each render frame; cleans up on entity remove                                                                                 |
| `tests/unit/weapon-anchor-resolver.test.ts`                                 | 8 deterministic tests: null entry fallback, absent-anchor fallback, explicit anchor right-facing, left-facing mirror, Y offset, left-art no-mirror, entity-pivot-offset, canonical offset |
| `docs/knowledge/review-ledgers/2026-07-17-weapon-anchor.review-ledger.json` | 3🍎 review ledger                                                                                                                                                                         |
| `docs/knowledge/metrics/apples/2026-07-17-weapon-anchor.json`               | Apple metrics                                                                                                                                                                             |

## Non-goals (deferred per issue)

- Authoring weapon anchors for existing enemies (no art changes in this PR).
- Changing projectile balance or telegraph timing.
- Left-art sprite support (all generated enemies face right).
- Melee weapon attachment (contract is generic enough; consumers just read `entityWeaponAnchors`).

## Known open items

- No existing enemies have weapon anchors authored, so the runtime behavior is identical to pre-feature (falls back to entity pivot). The feature activates transparently when art is approved with a weapon anchor in the manifest.

## Acceptance criteria met

1. ✅ Editor can display, set, and reset a weapon anchor via `POST /weapon-anchor` route.
2. ✅ Explicit weapon anchor round-trips from editor state → `NN.anchor.weapon.json` → manifest → registry.
3. ✅ Runtime falls back to entity ECS/visual pivot when no anchor is present (deterministically tested).
4. ✅ Both telegraph and immediate-fire paths consume the same resolved anchor without drift.
5. ✅ Contract is generic (`entityWeaponAnchors`) — melee enemies can use same map.
6. ✅ 8 deterministic unit tests cover explicit anchor, missing-anchor fallback, facing transformation paths.
