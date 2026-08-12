# Handoff: Deterministic 47-mask terrain packs

## Systems touched

sprite-pipeline, sprite-workflow, mapgen

## Summary

Added a reusable 64x64 terrain-pack contract and deterministic build pipeline for
47-mask blob walls, topology-free floor/corridor variants, and oriented door
states. Floor 2 now uses the first production pack, `industrial-cave`, while
Floor 1 keeps its existing 16-mask/generated-texture behavior.

The implementation also vendors an immutable CC0 fixture pack derived from
Caeles' Seamless Tileset Template II. Both packs build into explicit 8x6 wall
atlases and validate all 47 canonical masks, dimensions, paths, PNG structure,
edge compatibility, and pinned provenance.

## Persona and complexity

- Persona: Producer, routing implementation through engine, sprite-tooling, QA,
  security, and review-harness specialists.
- Verdict: recommended.
- Estimated: 5 apples.
- Actual: 5 apples.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-11-47-mask-terrain-packs.review-ledger.json`
  (adversarial plan review, two-round correctness review, and adjudicated
  multi-model review).

## What shipped

- A shared 8-neighbor mask model with pinned bit semantics and canonical
  diagonal normalization from 256 raw neighborhoods to exactly 47 masks.
- Strict terrain-pack manifests with explicit mask-to-frame mappings, separate
  wall/floor/corridor/door contracts, runtime/build-only registration, and
  immutable provenance.
- A deterministic quadrant-kit assembler that emits 512x384 atlases containing
  8x6 cells at 64x64, plus build/validate package commands.
- A vendored CC0 fixture with source URL, license, author, original dimensions,
  and SHA-256 enforcement.
- The `industrial-cave` production pack with four floor variants, four corridor
  variants, and open/closed horizontal/vertical doors.
- Runtime pack preloading, 47-mask wall frame selection, coordinate-seeded
  floor/corridor variation, oriented door rendering, and safe fallback to the
  legacy renderer when a configured texture is unavailable.
- Floor 2 manifest selection of `industrial-cave`; Floor 1 remains unchanged.
- Theme-level brief vocabulary that keeps generated inputs separate from the
  deterministic topology assembly step.

## Key decisions

- Azure/the art source produces style-consistent parts and motif tiles; topology
  indexing is assembled deterministically in-repo.
- Runtime and tooling share one mask normalizer so atlas generation and frame
  resolution cannot drift.
- Atlas semantics are declared by mask ID rather than inferred from sheet
  position.
- Pack contracts are per surface: walls are topology-bound, floors/corridors
  use deterministic variation pools, and doors are authored by state and
  orientation.
- Only production packs enter the static runtime preload registry. The CC0
  fixture remains build/test-only.
- Existing 16-mask and generated-single-texture paths remain available for
  incremental migration.

## Fixture provenance

- Source: `https://opengameart.org/content/seamless-tileset-template-ii`
- Original file: `template8x6.png`
- License: CC0
- Original dimensions: 256x192 (8x6 cells at 32x32)
- SHA-256:
  `34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76`

## Observe before done

- Before: the terrain renderer had no 47-mask runtime path. Generated tile art
  was stamped as a single texture and therefore bypassed topology-aware wall
  frame selection.
- After: `tests/e2e/terrain-pack-floor2.test.ts` boots the real Floor 2
  `MainGameScene` through `BootScene`, `createFloorGameConfig`, and
  `createFloorMainSceneOptions` with seed 4242. The live scene reports nonzero
  `packWallCount` and `packFloorCount`, with pack walls exceeding generated
  single-image stamps. Pack doors report zero missing configured textures when
  renderable doors exist.
- The real-scene probe now accepts `?floor=floor2` and exposes terrain-pack and
  pack-door provenance without changing existing Floor 1 probe behavior.

## Validation

- `npm run terrain-packs:build` emits both packs.
- `npm run terrain-packs:validate` accepts both packs.
- Exhaustive tests prove all 47 canonical masks resolve exactly once with no
  missing or duplicate cells.
- Tooling tests cover dimensions, path containment, PNG structure, provenance
  hashes, seam compatibility, malformed manifests, directories, and unreadable
  paths.
- Runtime tests cover atlas resolution, deterministic variants, preload
  selection, legacy fallbacks, Floor 2 selection, door orientation, and missing
  texture diagnostics. Missing pack-door warnings are emitted at most once per
  scene rather than once per render frame.
- `tests/e2e/terrain-pack-floor2.test.ts` passes against the real booted Floor 2
  scene.
- The full parallel headless suite exposed two unchanged fused-pathing
  determinism guards whose 180-second default budget was below their loaded
  Windows runtime. Their assertions and frame budgets are unchanged; both now
  use an explicit 300-second test timeout and pass in isolation and in the full
  suite.
- `npm run verify:fast` passes.
- `VERIFY_FULL=1 npm run verify` passes.

## Follow-up

Future themes can add a manifest and source parts without changing runtime or
assembler code. Cosmetic wall alternates remain optional and must preserve
boundary pixels.
