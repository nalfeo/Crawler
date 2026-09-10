# Assets Promote Walk-Cycle Recovery

**Date:** 2026-09-01  
**Persona:** Graphics Designer  
**Apples:** 1🍎 estimated / 1🍎 actual (exact)

## Systems touched

sprite-pipeline, ci-policy

## Summary

Recovered the `assets/promote` PR after its directional male walk-cycle aggregate
failed the shipped-art wiring guard. The engine supports the existing four-frame
walk strip, but the queued aggregate declared a 32-frame, eight-direction grid
that the runtime would animate sequentially.

## Files touched

- `public/assets/generated/player-walk-cycle-male.png`
- `public/assets/generated/entries/player-walk-cycle-male.json`

Both files were restored exactly to their pre-reconciliation versions. The seven
new directional source assets remain in the promotion.

## Verification

- `npx vitest run --project unit tests/unit/entity-sprite-mapping-art-wiring.test.ts`
- `npm run check:manifest-hard-blocked`
- `npm run verify:fast`
- `runtime-tools-secret_scanning` on both restored asset files

## Unresolved issues

None for this promotion.

## Recommended next steps

Promote the directional aggregate only after the generated-asset schema and
runtime animation selection support directional frame ranges.
