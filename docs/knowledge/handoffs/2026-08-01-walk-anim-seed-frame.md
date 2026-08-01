# Seed-frame identity pinning for walk-cycle generation

**Date:** 2026-08-01  
**Branch:** nalfeo-walk-anim-reference-frame-recovery  
**Apple estimate:** 2🍎

## Summary

Adds a `seedFrames` field to the sprite brief schema so pre-approved PNG frames
can be passed as first-priority reference images during generation. The primary
use case is walk-cycle sheets: passing an approved frame 0 as a seed locks the
model onto that character's identity/palette/proportions for frames 1–N,
eliminating the row-0 vs row-1 lighting/outfit-angle drift seen in earlier
`player-walk-cycle-female` generations.

## Systems touched

sprites

## Files touched

- `scripts/sprites/brief-schema.ts` — `seedFrames` field added to briefSchema
- `scripts/sprites/build-prompt.ts` — `seedFrameBlock()` + `cartoonFigureRules()` updated
- `scripts/sprites/generate-one.ts` — seed PNGs prepended before style refs; path-traversal guard
- `briefs/characters/seeds/player-walk-cycle-female-frame0.png` — approved seed PNG
- `briefs/characters/player-walk-cycle-female-v2.yaml` — new brief using seed frame
- `tests/unit/sprites/brief-schema.test.ts` — fixture updated
- `tests/unit/sprites/build-prompt.test.ts` — stale assertion fixed; 7 new seedFrames tests
- `tests/integration/generate-one.test.ts` — 2 new integration tests
- `tests/integration/weapons-pipeline.test.ts` — fixture updated
- `docs/knowledge/review-ledgers/2026-08-01-walk-anim-seed-frame.review-ledger.json`

## Verification

`npm run verify:fast` ✅  
Sprite unit tests (158 tests): ✅  
Sprite integration tests (20 tests): ✅

## How seedFrames works

1. **Schema** — `seedFrames: z.array({ path: string, note?: string })` defaults to `[]`.
   Paths are relative to the repo root; generation-time validation rejects traversal outside root.

2. **Prompt** — when `seedFrames.length > 0`, `buildSheetPrompt` prepends a
   `## Seed frames (HIGHEST PRIORITY)` block before the floor-context section, and
   `cartoonFigureRules` switches the reference-image instruction from "copy technique only"
   to "match EXACTLY in character identity/palette/outfit".

3. **Provider** — `generateSheetCore` loads the seed PNGs and prepends them to
   `referencePngs` so provider slot indices match the prompt's description.

## Unresolved issues

- `player-walk-cycle-female-v2.yaml` has not been run yet (seed-frame pipeline is now
  wired; generation can proceed via `npm run sprites:run -- --brief player-walk-cycle-female-v2`).

## Recommended next steps

1. Run `player-walk-cycle-female-v2` through the pipeline and compare frame consistency
   against `player-walk-cycle-female` (original, no seed).
2. If consistency is improved, back-apply `seedFrames` to the male and androgynous variants.
3. Consider extracting the seed frame automatically from an approved generation rather
   than requiring a manual PNG extraction step.
