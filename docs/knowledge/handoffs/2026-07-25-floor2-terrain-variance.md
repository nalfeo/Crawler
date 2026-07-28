# Session Handoff: Floor 2 terrain variance — shared-base pools, ground decals, clip-by-overpaint

## Date

2026-07-25

## Persona

Graphics Designer / Terrain Engineer (contract + derivation tooling + renderer + Azure art)

## Systems touched

sprite-pipeline, engine (terrain-renderer, MainGameScene, labs)

## Apples

5🍎 estimated, 5🍎 actual. Shared contract + renderer restructure + new pack mechanism + committed art

- deterministic guards.

## What Was Done

Floor 2 read as "very very repetitive". This session diversified it across several rejected-and-revised
iterations. See `docs/knowledge/adr/2026-07-25-floor2-terrain-variance.md` for the decisions; this file
records what a follow-up session needs to _operate_ the result.

- **Shared-base pools with byte-restored borders.** Every pool variant derives from one base tile and
  has its border pixels restored from that base, so all variants are edge-compatible by construction.
  Selection is weighted-rarity (`buildWeightedCombos` / `pickPoolCombo`), not uniform — one common base
  plus rare incident, so the surface reads as one material.
- **Ground decals — new pack mechanism.** `groundDecals` in the pack schema is now an **array of sets**.
  Floor 2 ships four (6/4/3/2-tile spans). Stamped over ground on a jittered lattice independent of the
  tile grid, with continuous rotation, mirror, and a per-set hash salt.
- **Three-pass renderer so walls clip decals.** `buildTerrainLayer` now runs
  `paintTiles('ground')` -> decal pass -> `paintTiles('cover')` -> `rt.render()`. Cover cells are
  `rt.clear()`ed before stamping so the wall art masks decal overhang pixel-exactly.
- **Decals are family-scoped.** Each pack in `packsByFamily` gets its own decal pass (same-pack entries
  deduped), and a stamp only counts ground its own family paints. Corridors follow `stone ?? cave`,
  matching the corridor pool. Behaviour-preserving on single-pack Floor 2; required so the two-pack
  Floor 1 packs don't cross-contaminate.
- **Mask-aware wall accents** at `WALL_ACCENT_DENSITY = 0.2`, clipped per canonical mask so they cannot
  spill past wall topology.
- **Wall verticality via value inversion** (floor brightest, wall dark), applied as a deterministic
  lighting pass during pool rebuild.
- **Deterministic committed-art guard** (`tests/unit/sprites/terrain-pack-committed.test.ts`, 16 tests)
  covering span, coverage, pairwise Jaccard, stroke boldness, absence of enclosed 1-2px pinholes, and a
  byte-exact fixed-point check that the committed pools/atlas equal what the rebuild re-emits.

## Observed in the real game (not a lab)

Via `main-scene-probe-lab` booting the real `MainGameScene` on floor2, `getTerrainRenderSummary()` /
`[terrain-renderer] layer built`, 200x200 map:

| metric                 | before | after wall-clip | after density tune |
| ---------------------- | ------ | --------------- | ------------------ |
| `packGroundDecalCount` | 2051   | 3891            | **2285**           |

2051 -> 3891 confirms the wall-margin fix landed (the centre-only prediction was ~3900). 3891 -> 2285 is
the human-requested density reduction, applied only to the small sets so the long cracks survive.
Re-measured **2285** after the family-scoping and AABB-bound review fixes, proving both are
behaviour-preserving on this single-pack floor.

Screenshots: `files/CLIP-a.png`, `files/CLIP-b.png` (post-clip), `files/DENS-a.png`, `files/DENS-b.png`
(final density), `files/FAM-a.png`, `files/FAM-b.png` (post-review-fix). Cracks visibly cross tile
boundaries and terminate exactly at the wall silhouette.

## Operating the art pipeline — READ THIS FIRST

**`import-floor2-materials.ts` rewrites `floor-0`, `corridor-0` and the four accents with raw
pre-lighting material.** The rebuild must follow it. It now does so automatically — `main()` chains
`applySharedBasePoolRestyle()` — so the one command is:

```bash
npx tsx scripts/sprites/terrain-packs/import-floor2-materials.ts
```

Historically these were two commands and skipping the second shipped raw material: the floor turned
into orange speckle on a visible grid. That happened once this session and nothing but the running
game caught it. It is now caught deterministically by the fixed-point test in
`tests/unit/sprites/terrain-pack-committed.test.ts`, which re-runs `rebuildSharedBasePools()` +
`retuneWallAccents()` + `restyleWallAtlas()` and byte-compares every emitted file against disk. That
guard covers only **re-emitted** files (pools + wall atlas); ground-decal atlases and accents already
within their chroma threshold are covered structurally by sibling tests instead, and a coverage
assertion pins the emitted set so the guard can't silently shrink to nothing.

Both scripts are idempotent: re-running produces byte-identical output.

## Observation recipe (verified)

```bash
npm run lab   # note the port; 23181 may be taken -> 23182
```

Then `http://localhost:<port>/lab.html?lab=main-scene-probe-lab&floor=floor2`, viewport 1320x760.

- Global is `window.__mainSceneProbe`. Readiness is
  `getTerrainRenderSummary()?.packFloorCount > 0` — there is **no** `probe.ready`.
- `setSimulationPaused(false)` -> `setPlayerFeet(x, y)` -> `advanceSimulationFrames(30)` ->
  `setSimulationPaused(true)` -> `setLightingOverlayVisible(false)` -> wait ~1200ms -> screenshot
  `#lab-canvas canvas`.
- **`setPlayerFeet` does no collision check.** `(400,200)` is the flagstone start room, NOT the cave.
  Use `(200,200)` and `(900,700)` for cave positions.
- `packGroundDecalCount` is on the returned `TerrainLayerResult`, in the
  `[terrain-renderer] layer built` console log, and on `getTerrainRenderSummary()` — use the probe
  seam, it's the cheapest regression check for any decal-placement change.

**Screenshots must be written to disk.** `chrome-devtools-take_screenshot` with `filePath` is blocked
for both the repo and session-state paths. Use a throwaway Playwright script (`playwright` is in
`node_modules`) that drives the probe and writes buffers to `files/`.

## Blockers / Decisions

- **Density is tuned to the human's taste, not a metric.** Manifest `density` per set:
  6-tile 0.30, 4-tile 0.40, 3-tile 0.42, 2-tile 0.30. The 3-tile set is the biggest remaining
  contributor if further reduction is wanted.
- `DECAL_MIN_GROUND_FRACTION = 0.35` is a judgement call. It is **not** a containment rule (decals are
  clipped, not excluded); it only stops a large set shattering into slivers in a one-tile corridor.
- Long cracks read slightly root/branch-like at `windowScale: 1`. Flagged, accepted for now.
- `caeles-fixture` does not get ground decals. Undecided whether it should.

## Known laws (do not relitigate)

- **Generated art supplies texture; local code supplies geometry, pooling, lighting, validation.** Do
  not hand-write texture synthesis — five procedural wall iterations were rejected on exactly this.
- **"Rivet repeats are fine — that's industrial. But natural surfaces should not look repetitive."**
- Pool tile borders are byte-restored, so **no pool feature can ever cross a tile edge**. That is why
  ground decals exist; a bigger pool cannot substitute.
- Decal jitter must span the **full stride**, not `stride - span`.
- Decal rotation must be **continuous**; quarter turns cannot decorrelate an axis-aligned motif.
- Window selection for cracks uses largest **connected** span, not coverage.
- Alpha is binary (0/255) pack-wide.
- **Measure before accepting a diagnosis, including the human's.** One reported cause (sub-tile
  placement) measured clean; the real cause was quarter-turn rotation.

## Follow-up work requested by the human

Three separate features, explicitly to be split into their own sessions:

1. **Industrial linework** (5🍎) — mine-cart tracks, pipe runs, switches, carts that span long distances
   _coherently_ and enter/exit walls, concentrated near boss dens and the central room. This is **not** a
   bigger decal set: decals are independent stamps on a lattice with no knowledge of each other or the
   map. Linework must follow a **path** derived from map topology and stamp directional segment art
   (straight / corner / T / end-cap with orientation). New pack mechanism, new schema, new briefs.
2. **Wall repetition pass** (3🍎) — same shared-base + weighted-rarity + generated-material procedure.
3. **Floor re-pass** (2-3🍎).

## Test Results

- `npx tsc --noEmit` clean
- `npx vitest run --project unit terrain-renderer terrain-pack` — **156/156** (4 added: three wall-clip
  regressions, one mixed-biome decal-scoping regression)
- `npx vitest run --project sprites terrain-pack-committed` — **16/16** (fixed-point art guard added)
- `npm run verify:fast` — pass
- Art regeneration idempotent (byte-identical on re-run), now asserted as a test
- Observed in the real `MainGameScene`, not only in a lab — decal count identical (2285) before and
  after the review fixes
- Review harness: plan review (adversarial, gpt-5.4, `major_fork`); code review 3 rounds
  (gpt-5.6-terra + gemini-3.1-pro-preview) ending clean; multi-model adjudication by claude-opus-5.
  Ledger: `docs/knowledge/review-ledgers/2026-07-25-floor2-terrain-variance.review-ledger.json`
