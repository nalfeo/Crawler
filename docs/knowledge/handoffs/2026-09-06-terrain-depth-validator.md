# Terrain depth validator

## Systems touched

sprite-pipeline, terrain-packs, mapgen

## Summary

Wired the terrain depth/perspective validator into the production terrain-pack
validation CLI for runtime packs. The validator now inspects decoded wall and
accent pixels rather than trusting the presence of `wallAccents`: it checks
dimensions, visible coverage, tonal variation, vertical distribution, and
contrast against the wall atlas. Build-only fixture packs remain outside this
runtime art contract.

## Evidence

Before the fix, `npm run terrain-packs:validate` never called the depth check
and could accept a flat Floor 1 or Floor 3 manifest. After the fix, the real
terrain-pack validation CLI reports `terrain-pack-lacks-depth` for
`floor1-dungeon`, `floor1-cave`, and `companion-overworld`, while
`industrial-cave` passes. The committed regression suite also rejects a
full-frame flat accent and accepts the shipped Floor 2 accent atlases.

## Apples

Estimated: 3. Actual: 3. Verdict: exact. This stayed within the planned
validator, CLI wiring, and regression-test scope.
