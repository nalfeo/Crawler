# Sprite Mapping Corruption Repair

**Date:** 2026-08-14  
**Type:** Asset integrity repair  
**Apples:** 3

## Systems touched

sprite-pipeline, set-pieces

## Summary

Repaired every confirmed current sprite-content swap found by hash and historical
comparison:

- Restored the approved PNGs and matching shard hashes for welcome-room bookcase,
  desk, rug, velvet rope, shop table, and wall shelf.
- Restored the Frost Nova ability icon after it was replaced with the Slime Rat
  stopgap image.
- Removed 1,353 machine-local postprocess provenance paths from 451 committed
  generated-asset shards, normalized 114 escaping `sourceRun` values, and stopped
  future approvals from writing machine-local provenance. The integrity guard now
  rejects either regression across the committed corpus.
- Updated welcome-room layer footprints to match the restored sprites' opaque
  bounds, so authored dimensions equal the renderer's actual output.

`rat-slime-v1-var-1` and `rat-slime-v1-var-2` were clean. The
`slime-rat-boss-var-1` dark-creature asset remains a known art gap, not a
recoverable content swap; no historical correct Slime Rat asset exists, and the
maintainer chose not to commission replacement art in this repair.

## Root cause

The stale sprite queue/reconciler path could stage historic asset bytes, while
updating the corresponding shard hash made a wrong filename-to-image assignment
self-consistent. The earlier history-based filter did not protect already-open
promotion PRs. Absolute postprocess paths were independently leaked by
`scripts/sprites/approve.ts` into committed manifest shards.

## Validation

- `npm run check:asset-integrity`
- `npm run test:sprites -- tests/unit/sprites/approve.test.ts`
- `npm run test:unit -- tests/unit/set-piece-declared-feet.test.ts`
- `npm run typecheck`
- `npm run verify:fast`
- `npm run sprites:derive-opaque-bounds -- --check`
