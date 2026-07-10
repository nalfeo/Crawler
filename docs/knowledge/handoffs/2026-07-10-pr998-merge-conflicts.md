# Handoff: PR #998 merge conflict resolution

**Date:** 2026-07-10  
**PR:** #998  
**PR branch:** `copilot/nalfeo-997-set-piece-editor-runtime-parity`  
**Apple estimate:** 2🍎  
**Actual apples:** 2🍎  
**Verdict:** Completed

## Systems touched

devtools, enemies, mapgen

## Summary

Resolved the branch-vs-`main` merge conflicts for PR #998 and kept both the
set-piece parity work and the newer base-branch behavior.

- Kept the editor/runtime parity changes in
  `.github/extensions/set-piece-editor/extension.mjs` (depth-band draw order,
  center-snapped NPC placement, multi-layer prop footprint sizing, quarter-step
  resize snapping, sanitized error responses).
- Preserved the newer `main` behavior that syncs the base prop layer's
  `widthFt`/`heightFt` with inspector-driven prop size edits.
- Fixed the merge-induced semantic mismatch in `spawnNpc`: unknown `defId`
  now returns `-1` before validating paired size overrides, matching the merged
  test expectation.
- Kept the merged lab/test/docs updates from `main`, including the
  `world-objects` regression test and the set-piece lab hover-depth/runtime
  transform evidence additions.

## Validation

```bash
cd .github/extensions/set-piece-editor
node --test tests/editor-validators.test.mjs tests/editor-gestures.test.mjs

cd /home/runner/work/Crawler/Crawler
npx vitest run tests/ecs/spawners/world-objects.test.ts
npm run verify:fast
```
