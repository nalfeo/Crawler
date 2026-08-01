# Fix: Icon Batch Sheet Slicer — Alpha-Channel Transparency Bug

**Date:** 2026-07-31  
**Branch:** copilot/run-icon-batch  
**Apple estimate:** 2🍎

## Summary

Fixes a bug where the sprite sheet slicer produced **1 cell instead of 16** when
processing ability icon batches on transparent backgrounds. This caused the
`ability-icons-batch-01` CI run (Issue→Action channel 3 e2e test, issue #2490)
to fail with:

```
icon-batch: fatal: Run produced 1 processed cells but iconBatch has 16 entries.
```

## Root Cause

`findBgColumns`, `findBgRows`, and `inferContentBounds` in
`scripts/sprites/slice-sheet.ts` determine gutter bands by comparing pixel RGB
values against an estimated background colour (measured from the four corner
pixels). The functions **ignored the alpha channel entirely**.

For a transparent-background icon sheet:
- Corner pixels: alpha=0, RGB=(0,0,0) → estimated background = (0,0,0)  
- Interior gutter pixels: alpha=0, but RGB may retain non-zero "bleed" values
  from the generator (e.g. RGB=(150,100,200))

The euclidean RGB distance of those gutter pixels from (0,0,0) exceeded the
24-pixel threshold → gutter pixels classified as **foreground** → no interior
bands detected → entire sheet treated as 1 cell → `approveIconBatch` count guard
throws.

## Fix

Added an early-exit for fully-transparent pixels in all three functions:

```typescript
if ((sheet.data[idx + 3] ?? 255) === 0) continue; // alpha=0 → always background
```

A fully transparent pixel is background by definition, regardless of whatever RGB
values happen to be stored at that position in the PNG file.

The `?? 255` default ensures graceful handling of PNGs without an alpha channel
(where the byte is absent) — they default to opaque (255), leaving the existing
RGB-distance logic unchanged.

## Files Changed

- `scripts/sprites/slice-sheet.ts` — alpha check in `findBgColumns`,
  `findBgRows`, and `inferContentBounds`
- `tests/unit/sprites/slice-sheet.test.ts` — 4 new tests in
  `transparent-background sheet slicing (icon batch)` describe block

## Verification

- Logic verified manually (no npm cache available in sandbox)
- 4 regression tests added; the primary one reproduces the exact failure
  condition: corners=(0,0,0), gutter=(150,100,200), alpha=0 throughout
- CI runs these tests in the `unit` project (`vitest run --project unit`)
- `npm run review:ledger -- validate` → ✅ valid 2-apple ledger
- `npm run verify:pr-prereqs` → ✅ passes

## Systems touched

sprites-pipeline
