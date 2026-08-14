# Handoff: Disable opaque-ratio sensor for tile briefs

**Date:** 2026-07-06
**Session:** tile-opaque-ratio-disable
**Apple estimate:** 🍎 | **Actual:** 🍎 | **Verdict:** exact

## Systems touched

sprite-pipeline

## Summary

Disabled the opaque-ratio sensor for tile sprite briefs because tile outputs intentionally occupy most or all of the canvas, so the default opaque-ratio threshold is not a meaningful quality signal for that type.

Added an explicit `disabled` switch in the opaque-ratio brief override schema, then updated candidate scoring to short-circuit that sensor when the flag is enabled.

Applied the override in `data/sprite-types/tile.json` with `"opaqueRatio": { "disabled": true }`.

## Files touched

- `scripts/sprites/brief-schema.ts`
- `scripts/sprites/score-candidate.ts`
- `data/sprite-types/tile.json`
- `docs/knowledge/review-ledgers/2026-07-07-tile-opaque-ratio-disable.review-ledger.json`

## Verification run

- `npx vitest run --project unit tests/unit/sprites/score-candidate.test.ts` (24 passed)
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-07-tile-opaque-ratio-disable.review-ledger.json` (valid 1-apple ledger)

## Unresolved issues

None.

## Recommended next steps

- If additional sprite families need to bypass opaque-ratio, enable `sensors.opaqueRatio.disabled` in those specific briefs rather than changing global defaults.
