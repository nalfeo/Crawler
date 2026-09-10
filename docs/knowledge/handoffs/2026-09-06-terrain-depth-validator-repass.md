---
title: Terrain depth validator repass
date: 2026-09-06
---

## Systems touched

sprite-pipeline, sprite-workflow, mapgen

## Apples

Estimated: 3; actual: 3; verdict: on-target.

## Outcome

Addressed the review findings for issue #4377. The terrain depth validator now
checks mask-derived exposed wall-face bands in addition to pixel variation,
rejecting varied full-wall textures that lack wall-to-floor layering. The
production terrain-pack CLI returns a validation failure when runtime packs
lack depth cues, while the industrial-cave Floor 2 reference passes.

## Evidence

- `tests/unit/sprites/terrain-pack-committed.test.ts`: Floor 2 positive,
  Floor 1/3 negative, varied-but-flat regression, and production CLI gate.
- `npm test -- --run tests/unit/sprites/terrain-pack-committed.test.ts`
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`

## Observation

The real terrain-pack validation CLI reports `terrain-pack-lacks-depth` for
`companion-overworld`, `floor1-cave`, and `floor1-dungeon`, while reporting
`industrial-cave` OK. This is the intended deterministic before/after gate
for the shipped terrain-pack artifact.
