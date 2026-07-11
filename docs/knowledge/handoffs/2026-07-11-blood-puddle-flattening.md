# Blood puddle flattening

## Date

2026-07-11

## Persona

Graphics Designer

## Systems touched

vfx

## Apples

Estimated: 🍎🍎  
Actual: 🍎🍎  
Verdict: 🎯 Exact — a focused renderer change plus deterministic and runtime verification.

## Summary

Blood puddles now keep their existing horizontal spread while their vertical scale
decreases linearly from 100% to 50% over the 30-second spread-and-fade lifetime.

## Files touched

- `src/engine/GoreVfx.ts` — applies the lifetime-based vertical scale during redraw.
- `tests/unit/vfx-world-coords.test.ts` — verifies unchanged width and vertical scales
  of 100% at spawn, 75% halfway through life, and approximately 50% near full fade.

## Verification

- Regression test failed before the renderer change at the halfway assertion
  (`scaleY` remained 1 instead of 0.75).
- `npx vitest run tests/unit/vfx-world-coords.test.ts` — passed, 5 tests.
- `npm run verify:fast` — passed, 3,448 tests.
- Running game at `http://127.0.0.1:4174` — selected the sword loadout and captured
  blood puddles at 8, 14, and 24 seconds. The real game continued to render and age
  the pools on their ground-effect layer with no runtime errors.

## Unresolved issues

None.

## Recommended next steps

Merge after required validation passes.
