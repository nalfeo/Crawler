# Handoff: icon batch transparent-black review fix

**Date:** 2026-08-01  
**Issue/PR:** nalfeo/Crawler PR `fix(sprites): treat alpha=0 pixels as background in sheet slicer`  
**Persona:** Graphics Designer  
**Apple estimate:** 2🍎

## Systems touched

sprite-pipeline

## Summary

Addressed the remaining PR review finding by making transparent-backed sheet
classification ignore transparent-corner RGB entirely. When all sampled corner
pixels are transparent, the slicer now treats every nonzero-alpha pixel as
foreground instead of comparing opaque content against meaningless transparent
RGB values.

## What changed

- `scripts/sprites/slice-sheet.ts`
  - Replaced the raw corner-RGB background estimate with an alpha-aware
    `BackgroundSample`.
  - Transparent-backed sheets (`opaqueSamples === 0`) now classify
    `alpha > 0` pixels as foreground in `findBgColumns`, `findBgRows`, and
    `inferContentBounds`.
  - Opaque-backed sheets keep the previous RGB-distance behavior, but now only
    average opaque corner samples.
- `tests/unit/sprites/slice-sheet.test.ts`
  - Added a regression case for opaque black icon blocks on a transparent sheet
    with zeroed black corner RGB.
  - Generalized the transparent-grid fixture helper so tests can pin exact
    foreground colors.

## Verification

- Separate-model validator (`code-review` agent) confirmed the review finding
  remained valid on the branch head before the fix.
- `git diff --check` ✅
- Standalone deterministic node audit of the updated classification logic ✅
  - transparent-backed 2×2 black-content sheet: transparent mode engaged,
    content bounds detected, 3 background bands per axis
  - opaque-backed 3×3 sheet: opaque mode preserved, 4 background bands per axis
- `npm run verify:fast` ❌ environment-blocked because this worktree is missing
  installed project dependencies (`typescript`, `@eslint/js`, `vitest`, `pngjs`,
  etc.) and `npm ci` cannot restore them in the sandbox due DNS
  `ENOTFOUND ms-feed-12.pkgs.visualstudio.com`

## Review-thread follow-up

- After pushing the repair commit, reply on review comment `3696165471` with the
  required `✅ Addressed in <sha>:` marker so CI recovery can auto-resolve the
  thread.
