# Handoff: Set-piece editor/runtime WYSIWYG parity follow-ups

**Date:** 2026-07-10  
**Issue:** #997  
**PR branch:** `copilot/nalfeo-997-set-piece-editor-runtime-parity`  
**Apple estimate:** 3🍎  
**Verdict:** Completed

## Systems touched

devtools, mapgen, ci-policy

## Summary

Implemented all deferred WYSIWYG parity items from PR #995 review (issue #997).

### Items delivered

1. **Scene-layer order parity** — `globalZ(layerId, kind, localZ)` now uses
   `setPieceZToDepth(z)` (mirrored from `src/shared/render-depths.ts`) to sort
   editor drawables in the same depth bands as runtime. NPCs without an authored
   `z` sort at `ENTITY_DEPTH=0`, exactly matching the runtime entity band.

2. **Multi-layer prop rendering parity** — `drawProp` now matches
   `stampSetPiece.ts` semantics: layer 0 defaults to the authored prop footprint,
   while non-first layers default to their native/custom sprite dimensions unless
   explicit `widthFt`/`heightFt` is provided.

3. **NPC coordinate/anchor parity** — Introduced `snapNpcCenter()` helper in
   `extension.mjs`. The three mouseup branches (`move-npc`, `move-npc-group`,
   `resize-npc`) now snap the NPC _center_ to the grid then derive the top-left,
   matching the runtime convention in `stampSetPiece.ts`
   (`centreTileX = boundedTileX + widthTiles/2`).

4. **Rotation clipping parity** — No code change needed; the old `ctx.clip()`
   was already removed during PR #995 development. Review thread was outdated.

5. **Interaction-test coverage** — Added production-browser interaction coverage in
   `.github/extensions/set-piece-editor/tests/editor-gestures.test.mjs` that drives
   the generated editor UI directly (drag/apply, resize, undo/redo, hit-testing,
   snap behavior, depth helpers). This suite now validates the real in-browser
   state machine instead of a copied helper module.

### Files changed

- `.github/extensions/set-piece-editor/extension.mjs`
  — `setPieceZToDepth` + `ENTITY_DEPTH` constants added inline  
  — `globalZ` signature expanded to `(layerId, kind, localZ)`  
  — 4 render-loop/hit-test `globalZ` callsites updated  
  — prop render/hit sort now includes runtime epsilon tie-break parity  
  — `drawProp` multi-layer size defaults aligned with runtime flattening  
  — `snapNpcCenter()` helper added  
  — 3 mouseup NPC snap branches updated to use center-snap

- `.github/extensions/set-piece-editor/tests/editor-gestures.test.mjs` _(new)_

## Key design decisions

- **Inline replication, not import**: `setPieceZToDepth` / `ENTITY_DEPTH` are
  replicated inline in the HTML-rendered browser JS (same pattern used
  throughout the file).
- **Center-snap preserves clamping**: `snapNpcCenter` snaps the computed center
  then clamps the resulting top-left to `[0, limit-size]`, so NPCs can never be
  dragged outside the canvas bounds.

## Testing

```bash
# Extension tests (Node built-in runner)
cd .github/extensions/set-piece-editor
node --test tests/editor-validators.test.mjs
node --test tests/editor-gestures.test.mjs

# Full repo fast verify
npm run verify:fast
```

## Observe Before Done (real artifact)

- Deterministic runtime/equivalence evidence for this branch is captured in real
  runtime-path tests, not editor-only stubs: `tests/unit/stamp-set-piece.test.ts`
  (set-piece layer flattening/stamp behavior) and
  `tests/unit/phaser-bridge.test.ts` (runtime bridge depth/render application).
- The production editor interaction suite
  (`.github/extensions/set-piece-editor/tests/editor-gestures.test.mjs`) exercises
  real generated-editor behavior (hit order, drag/resize, snap modes, undo/redo,
  apply payload) under Chromium.
