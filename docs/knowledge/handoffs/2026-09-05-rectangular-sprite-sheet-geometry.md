# Handoff: preserve detail on rectangular sprite sheets

**Date:** 2026-09-05
**Persona:** Producer / implementer
**Apples:** 2 estimated, 2 actual

## Systems touched

sprites

## Outcome

The sprite-brief pipeline no longer assumes a square canvas when it derives sheet geometry. The fix unifies native sheet sizing behind `sheetPixelDimensions()`, keeps rectangular 4x3 and 3x4 layouts faithful to their source aspect, rejects invalid remainders before provider spend, and keeps the prompt text, provider requests, and local A1111 slicing aligned on the same dimensions.

This addresses issue #4271 by porting the geometry semantics from PR #3234 onto the current mainline without broadening scope into animation or runtime changes beyond the sheet-generation contract itself.

## What changed

- `scripts/sprites/brief-schema.ts`
  - Added paired `nativeWidth` / `nativeHeight` handling alongside legacy square-style values.
  - Centralized the contract in `sheetPixelDimensions()` so one helper decides the effective canvas size.
  - Rejected invalid grid dimensions when the remainder exceeds one pixel in either axis before a provider request is sent.

- `scripts/sprites/build-prompt.ts`
  - Switched prompt layout text to the exact rectangular canvas and cell dimensions so model instructions match the real sheet geometry.

- `scripts/sprites/provider/types.ts`
  - Widened request sizing to accept a precise width/height pair instead of only a square-style number.

- `scripts/sprites/provider/azure-openai.ts`
  - Propagated the exact dimensions through the Azure request payload.

- `scripts/sprites/provider/local-a1111.ts`
  - Updated stitched-sheet sizing and slot math to respect rectangular sheet dimensions instead of silently flattening them to a square.

- `tests/unit/sprites/brief-schema.test.ts`
  - Added coverage for rectangular geometry and invalid remainder rejection.

- `tests/unit/sprites/build-prompt.test.ts`
  - Added prompt-coverage asserting the explicit 4x3 layout stays dimensionally correct.

- `tests/integration/sprites/local-a1111-provider.test.ts`
  - Added parity coverage proving a 4x3 rectangular sheet yields the intended 1024x768 native canvas and uniform cell sizing.

- `tests/unit/sprites/azure-openai.test.ts`
  - Added deterministic multipart coverage proving Azure requests `1024x768` for a 4x3 rectangular brief.

- `tests/unit/sprites/slice-sheet.test.ts`
  - Added deterministic content-aware slicing coverage for a 1024x768 4x3 sheet and its shared source-cell geometry.

## Validation

- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- focused unit geometry tests: 2 files, 55 tests, all passing
- local A1111 rectangular integration tests: 12 tests, all passing

## Notes

The core risk here was silent detail loss: a rectangular sheet was being interpreted through square-cell math and effectively reducing spatial density. The fix preserves the source intent across the prompt, provider request, and downstream stitching path, while failing fast for impossible geometry rather than accepting a degraded sheet.
