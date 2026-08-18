# Assets promotion taxonomy recovery

**Date:** 2026-08-18  
**Persona:** Graphics Designer  
**Apples:** 1 estimated / 1 actual

## Systems touched

sprite-pipeline

## What changed

- Recovered the `assets/promote` reconciliation PR's canonical-name gate by
  applying the repository taxonomy normalizer to the promoted generated assets.
- Retired ten `-v1-` lineage-tagged names and deterministically merged their
  approved variants into bare-concept ranges, preserving PNG bytes, hashes,
  anchors, and non-identity metadata.

## Deterministic evidence

- `npm run check:sprite-name-taxonomy` — passed.
- `npm run sprites:check-manifest` — passed.
- `npm run check:sort-assets` — passed.
- `npm run verify:fast` — passed.

## Remaining concerns

- None.
