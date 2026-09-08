# Session Handoff: Floor 3 overworld — review recovery (repro, weights, props, visual gate)

## Date

2026-09-06

## Persona

Producer

## Systems touched

mapgen, lighting, sprite-pipeline, testing

## Apples

3🍎

## What Was Done

Recovery pass on PR #4351 addressing five review threads on the Floor 3
`companion-overworld` terrain pack.

The critical discovery: the originally committed pack **failed the repo's own
pack validator**. `npm run terrain-packs:validate` reported
`authored-silhouette-mismatch` on all 47 masks and a compatible-boundary edge
pass rate of **0.298** — the hand-authored wall atlas was not the canonical
blob47 geometry at all. It shipped green only because no committed-art test
covered the new pack ID (the review's exact concern).

Fixes:

- **Reproducible generator** — added
  `scripts/sprites/terrain-packs/build-companion-overworld.ts`: pure
  `SeededRandom` procedural art (no generated-image step) composed onto the
  canonical silhouettes via `composeWallAtlas`, wired **unguarded** into
  `terrain-packs:build`. Rebuilding is byte-identical, so a canonical-geometry
  change is now repairable. All committed PNGs were regenerated; the pack now
  reports `[companion-overworld] OK`.
- **Pool weights** — floor/corridor pools declare `10:8:1x6` (grass base : quiet
  grass : sparse detail), matching the shared-base contract in
  `src/shared/terrain-pack-variants.ts` instead of drawing eight sources
  uniformly (the patchwork that contract replaced).
- **Prop selection** — `allowedCategories` can only narrow a biome, and every
  `organic` def is category `organic`, so the previous Floor 3 config dressed the
  bright overworld with Skull Pile / Bone Arch / Pustule. Added an explicit
  `allowedPropIds` allowlist to `PropPlacerConfig` + the floor-manifest schema;
  Floor 3 now selects `vine` + `moss-patch` only.
- **Committed-art coverage** — new
  `tests/unit/sprites/terrain-pack-companion-overworld-committed.test.ts`:
  schema, 47-mask coverage, atlas dimensions, 100% cardinal-edge classification,
  exact canonical silhouette, path resolution, non-degenerate luminance, bright
  outdoor mean luminance, green/earth hue, dominant-base weighting, and
  byte-for-byte rebuild reproducibility.
- **Real pixel capture** — `tests/e2e/terrain-generated-tiles.test.ts` now
  screenshots the real booted Floor 3 canvas and samples a fixed grid around the
  player, asserting Floor 3 renders >2x brighter than Floor 2's industrial cave
  with >60% of the window lit.

## Observe before done (real artifact)

Both floors were captured from the real `MainGameScene` booted through the
shipped floor bootstrap (`main-scene-probe-lab`), not a lab-only claim.
Recorded at the fixed probe seeds: **Floor 3 mean luminance 52.1** vs
**Floor 2 16.1** (3.2x), ~90% of the sampled window lit. Before the pack swap
Floor 3 rendered the same dark industrial-cave art as Floor 2.

## Key Decisions Made

- Chose "make the pack reproducible" over "document it as irreproducible": the
  art was procedural anyway, so a tracked generator is strictly better and also
  repaired the broken wall silhouettes.
- Rendered hue is dominated by the warm point light, so the **palette** gate
  lives on the committed PNG bytes (unit) and the **brightness** gate lives on
  the real canvas capture (e2e). Neither claim is made where it cannot be proven.
- Prop curation uses an explicit ID allowlist rather than a new `BiomeTag`,
  which would require new decoration defs and sprite art for no extra fidelity.

## What's Next / Blockers

- The pack is a deterministic procedural placeholder; a future hand-authored or
  generated art pass can replace it while keeping the manifest ID, weights and
  wiring intact. Any replacement must keep
  `terrain-pack-companion-overworld-committed.test.ts` green (or replace the
  reproducibility test with the generated-pack convention used by
  `industrial-cave`).
- No blockers.
