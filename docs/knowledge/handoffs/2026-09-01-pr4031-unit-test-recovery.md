# PR #4031 Unit Test Recovery

**Date:** 2026-09-01  
**Persona:** Producer / PR Shepherd  
**Apples:** 1🍎 estimated / 1🍎 actual (exact)

## Systems touched

sprite-pipeline, ci-policy

## Summary

Recovered PR #4031 after its promoted directional male walk-cycle aggregate
failed the shipped-art wiring guard. The runtime supports the original
four-frame walk strip, but the queued aggregate declared a 32-frame,
eight-direction grid that would animate sequentially.

## Files touched

- `public/assets/generated/player-walk-cycle-male.png`
- `public/assets/generated/entries/player-walk-cycle-male.json`

Both files were restored exactly to their pre-reconciliation versions.

## Verification

- `npx vitest run --project unit tests/unit/entity-sprite-mapping-art-wiring.test.ts`
- `npm run check:manifest-hard-blocked`
- `bash scripts/agent/verify-fast.sh`
- `npm run verify:pr-prereqs`
- Secret scan of both restored asset files

## Unresolved issues

None.

## Recommended next steps

Promote the directional aggregate only after the generated-asset schema and
runtime animation selection support directional frame ranges.
