# Handoff: enemy sprites face left by default

**Date:** 2026-07-05  
**Persona:** UX Designer  
**Apples:** estimated 🍎🍎 / actual 🍎🍎

## Systems touched

hud-ux, enemies, vfx

## Summary

Updated enemy rendering in `PhaserBridge` so mobs face left by default and only flip when moving right. Switched the implementation to `flipX` instead of signed scale so existing size math stays stable, and kept corpse-shatter capture using scale magnitude as a safe guardrail.

## Files touched

- `src/engine/PhaserBridge.ts`
- `tests/fixtures/phaser-bridge-harness.ts`
- `tests/unit/phaser-bridge.test.ts`
- `docs/knowledge/review-ledgers/2026-07-05-enemy-sprite-facing-left.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-05-enemy-sprite-facing-left.json`

## Review harness

- Ledger: `docs/knowledge/review-ledgers/2026-07-05-enemy-sprite-facing-left.review-ledger.json`
- Stages: `plan_review`
- Validation: `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-05-enemy-sprite-facing-left.review-ledger.json` ✅

## What changed

- Enemy visuals now keep their normal scale and toggle `flipX` only when horizontal velocity is meaningfully positive.
- Non-enemy visuals explicitly clear `flipX` so reused image objects cannot leak enemy facing state.
- Corpse-shatter capture still reads the absolute live scale as a defensive guardrail.
- Added regression coverage for:
  - default left-facing enemies,
  - the small-velocity jitter boundary,
  - right-moving enemies flipping,
  - right-facing baby-slime corpse shatter retaining positive shard scale.

## Verification run

- `npm test -- --run tests/unit/phaser-bridge.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify` ✅ after adding the ledger + handoff (dead-code warnings remain non-blocking in Step 4)

## Observe before done

- Runtime artifact: launched `npm run lab` and loaded `http://127.0.0.1:23361/lab.html?lab=enemy-ai-lab` in a headless browser. The page booted a live canvas and reported active enemy counters/state, confirming the render path was running in a real artifact.
- Deterministic before/after proof: `tests/unit/phaser-bridge.test.ts` now asserts the same enemy stays unflipped at rest / tiny rightward jitter, flips when moving right, and returns to left-facing when moving left.

## Unresolved issues

- None for this scope.

## Recommended next steps

1. If we want end-to-end visual coverage for mob facing, add a canvas-level lab snapshot/assertion that inspects rendered enemy orientation directly.
