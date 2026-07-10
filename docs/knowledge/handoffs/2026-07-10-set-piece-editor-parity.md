# Handoff: Set-piece editor/runtime WYSIWYG parity follow-ups

**Date:** 2026-07-10  
**Issue:** #997  
**PR branch:** `copilot/nalfeo-997-set-piece-editor-runtime-parity`  
**Apple estimate:** 2🍎  
**Verdict:** Completed

## Systems touched

set-piece-editor, set-piece-types, render-depths

## Summary

Implemented all deferred WYSIWYG parity items from PR #995 review (issue #997).

### Items delivered

1. **Scene-layer order parity** — `globalZ(layerId, kind, localZ)` now uses
   `setPieceZToDepth(z)` (mirrored from `src/shared/render-depths.ts`) to sort
   editor drawables in the same depth bands as runtime. NPCs without an authored
   `z` sort at `ENTITY_DEPTH=0`, exactly matching the runtime entity band.

2. **Multi-layer prop rendering parity** — `drawProp` previously defaulted
   non-first layers to `1×1 tile` target size. Fixed to always use `pw*ts` /
   `ph*ts` (the prop footprint) for any layer that doesn't declare an explicit
   `widthFt`/`heightFt`, matching `stampSetPiece.ts` semantics.

3. **NPC coordinate/anchor parity** — Introduced `snapNpcCenter()` helper in
   `extension.mjs`. The three mouseup branches (`move-npc`, `move-npc-group`,
   `resize-npc`) now snap the NPC _center_ to the grid then derive the top-left,
   matching the runtime convention in `stampSetPiece.ts`
   (`centreTileX = boundedTileX + widthTiles/2`).

4. **Rotation clipping parity** — No code change needed; the old `ctx.clip()`
   was already removed during PR #995 development. Review thread was outdated.

5. **Interaction-test coverage** — Created:
   - `.github/extensions/set-piece-editor/lib/editor-gestures.mjs` — pure
     functions extracted for testing: `normalizeRotationDeg`, `snapToStep`,
     `setPieceZToDepth`, `ENTITY_DEPTH`, `drawSortKey`, `npcCenterSnapPos`,
     `hitTestRect`, `historyPush`, `historyUndo`, `historyRedo`.
   - `.github/extensions/set-piece-editor/tests/editor-gestures.test.mjs` — 39
     unit tests covering all exported helpers; all pass.

### Files changed

- `.github/extensions/set-piece-editor/extension.mjs`
  — `setPieceZToDepth` + `ENTITY_DEPTH` constants added inline  
  — `globalZ` signature expanded to `(layerId, kind, localZ)`  
  — 4 render-loop/hit-test `globalZ` callsites updated  
  — `drawProp` multi-layer size default fixed  
  — `snapNpcCenter()` helper added  
  — 3 mouseup NPC snap branches updated to use center-snap

- `.github/extensions/set-piece-editor/lib/editor-gestures.mjs` _(new)_
- `.github/extensions/set-piece-editor/tests/editor-gestures.test.mjs` _(new)_

## Key design decisions

- **Inline replication, not import**: `setPieceZToDepth` / `ENTITY_DEPTH` are
  replicated inline in the HTML-rendered browser JS (same pattern used
  throughout the file). The `lib/editor-gestures.mjs` module is server-side only
  (like `lib/editor-validators.mjs`) and exists purely for testability.
- **Center-snap preserves clamping**: `snapNpcCenter` snaps the computed center
  then clamps the resulting top-left to `[0, limit-size]`, so NPCs can never be
  dragged outside the canvas bounds.

## Testing

```bash
# Extension tests (Node built-in runner)
cd .github/extensions/set-piece-editor
node --test tests/editor-validators.test.mjs   # 13 pass
node --test tests/editor-gestures.test.mjs     # 39 pass

# Full repo fast verify
npm run verify:fast   # 1155 tests pass
```
