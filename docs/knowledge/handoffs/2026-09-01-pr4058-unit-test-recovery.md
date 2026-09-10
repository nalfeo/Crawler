# PR #4058 Unit Test Recovery

**Date:** 2026-09-01  
**Persona:** DevOps Engineer  
**Apples:** 1🍎 estimated / 1🍎 actual (exact)

## Systems touched

sprite-pipeline

## Summary

Recovered the promoted male player walk-cycle artifact after Unit Tests found
that its directional 32-frame, 256×390 descriptor is unsupported by the
runtime's single-strip animation loader. Restored the prior compatible
four-frame, 256×256 sprite strip and descriptor.

## Files touched

- `public/assets/generated/entries/player-walk-cycle-male.json`
- `public/assets/generated/player-walk-cycle-male.png`

## Verification

- `npx vitest run --project unit tests/unit/entity-sprite-mapping-art-wiring.test.ts`
- `npm run check:manifest-hard-blocked`
- `npm run verify:fast`
- `npm run verify:pr-prereqs` (passes after this handoff is added)

## Unresolved issues

The directional aggregate remains unsuitable for promotion until the runtime
supports direction-specific animation ranges.

## Recommended next steps

Add runtime support and coverage for direction-specific frame ranges before
re-promoting the directional walk-cycle aggregate.
