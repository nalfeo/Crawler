# ADR: Floor 2 Generated Terrain-Pack Art — Render-Fix Wiring, Composed-Art Provenance, and Crenellation Geometry Fix

## Status

Accepted

## Date

2026-07-24

## Estimated Complexity

🍎🍎🍎🍎 x 1 — spans `scripts/sprites/` generation tooling, shared floor/pack manifest data,
and the engine render path (BootScene/MainGameScene); ships real generated art; no new lab
(reuses `terrain-pack-lab` + `main-scene-probe-lab`).

## Context

ADR `2026-07-11-47-mask-terrain-packs.md` established the 47-mask blob terrain-pack architecture
and scoped "wire Floor 2 to render via the new pack path." That landed, but with two latent gaps
discovered this session:

1. **The pack never actually rendered.** `preloadTerrainPacks` (`src/engine/sprites/terrain-pack-visuals.ts`)
   was dead code — no scene called it. The terrain renderer guards every pack stamp on
   `scene.textures.exists(textureKey)` and **silently falls through to the legacy Floor-1 tileset**
   when the texture is missing. Because pack textures were never queued into any Phaser loader,
   Floor 2 rendered **zero** pack tiles while appearing "wired" (manifest + registry all present).
   Measured before the fix: 0 pack walls / 0 pack floors on a representative Floor 2 seed.

2. **The art was procedural placeholder.** The `industrial-cave` pack shipped as deterministic
   quadrant-kit + speckle output, not real cave art. Additionally the shared wall-silhouette
   geometry produced a **crenellated** (castle-battlement) top edge instead of a clean cave wall
   face.

The approved 4🍎 ask: replace the placeholder `industrial-cave` art with real generated art, fix
the crenellation, and make Floor 2 actually render the pack — landed as a PR after the human
approved in-game screenshots.

## Decision

### 1. Composed-generation provenance model (committed PNGs are the source of truth)

Real art is produced by a **local, network-backed generate→compose loop** (untracked harness under
`scripts/sprites/terrain-packs/` (untracked `gen/` subfolder), Azure OpenAI `gpt-image-1`):

- `gpt-image-1` generates seamlessly-tileable **rock/floor/door materials**; the harness re-textures
  the **existing blob47 wall silhouettes** (via the same `composeWallCellOutput` geometry the
  procedural builder uses) so adjacent wall cells stay edge-continuous, then writes the pack PNGs.
- The **committed PNGs** under `public/assets/terrain-packs/industrial-cave/` are the **source of
  truth**. Generation is **not byte-reproducible** (a hosted model + local composition), so we do
  **not** claim a deterministic build. The manifest `provenance` block records this honestly
  (`kind: "authored"`, author names the Azure model + local composition, `derivationNote` states the
  committed PNGs are the artifact and are not byte-reproducible).
- The procedural builder (`build-industrial-cave.ts`) is **retained** (it still produces a valid
  fallback pack and is the geometry reference) but its disk writer is **env-guarded**
  (`TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE=1`) so a routine `terrain-packs:build` cannot silently
  clobber the shipped generated art.
- A new disk test (`tests/unit/sprites/terrain-pack-committed.test.ts`) validates the **committed
  manifest + shipped PNGs** (schema, 47-mask coverage, pool/door image existence+dims, atlas dims,
  and provenance honesty) — closing the gap that every prior test validated only the in-memory
  procedural builder, never the runtime source of truth (`terrain-pack-registry.ts` imports the
  committed manifest).

### 2. Render-fix: preload pack textures in `BootScene.preload()`

`preloadTerrainPacks(this.load)` is now called from `BootScene.preload()`. Phaser runs `preload()`
before `create()`, so pack textures are resident before `MainGameScene` bakes the terrain layer and
the `textures.exists()` guard passes. This is the single linchpin that turns the pack on
(0 → 11,509 pack walls + 28,291 floors on the representative Floor 2 seed). A **source-assertion
regression guard** (in `boot-scene-generated-sprite-gate.test.ts`) asserts the import + the
`preload()` call, because `BootScene` is Phaser-coupled and not headlessly instantiable (the
established pattern for scene guards in this repo).

### 3. Crenellation geometry fix in `quadrant-kit.ts`

The composed wall silhouette now uses a **uniform inset rectangle** (`WALL_INSET_PX = 48`) instead
of the per-quadrant carve that produced a battlement/crenellation top edge. Because a wall cell's
**alpha channel is the wall silhouette**, this fix lives in the shared compose geometry and applies
to both procedural and generated output. The **shipped generated atlas** passes the authored
edge-compatibility floor at **188/188 (100%)** — a durable geometric proof (asserted by the new
committed-pack test) that the corrected geometry is present in the shipped art, not just in a
freshly-built one.

## Consequences

### Positive

- Floor 2 renders real generated industrial-cave art (verified in the real `MainGameScene` via
  `main-scene-probe-lab` render counts + human-approved screenshots), not placeholder tiles.
- The "pack silently falls through to legacy tileset" failure mode is now guarded at the wiring
  linchpin, so a future pack can't ship inert the way this one did (cf. the `spawnerSystem` inert-
  ship class of bug, ADR 0034→0036).
- The committed pack (the runtime source of truth) is now independently validated on disk.
- Provenance is truthful about hosted-model generation without pretending to a deterministic build.

### Negative

- The generation harness (`gen/`) is **untracked** exploratory tooling, so regenerating the art is
  not a one-command repo operation — it requires the harness + Azure credentials. Documented in the
  session handoff.
- Two manifests describe the pack (the committed authored one and the procedural builder's output);
  they legitimately diverge in provenance. Mitigated by env-guarding the writer + the committed-pack
  test, but the divergence is a maintenance footgun.

### Risks

- The pack `doorSet` (4 PNGs) is **not yet runtime-consumed** — the engine door path
  (`resolveDoorRenderMode`) uses a global generated door texture, not the pack. Shipped honestly as
  not-yet-wired; tracked in #1902. Same not-yet-consumed status for `corridorPool` on the current
  Floor 2 seed (the cave generator emits no corridor tiles for it; the pool ships for future seeds).
- Generated art can only be regenerated with the untracked harness + Azure access; if lost, the
  committed PNGs remain authoritative but the process must be reconstructed from the handoff.

## Alternatives Considered

(From the adversarial plan review; all rejected with grounded reasons.)

1. **Make the build emit the committed art (deterministic "preview-output" builder).** Rejected:
   generation is a hosted-model + local-composition loop that is not byte-reproducible; forcing a
   deterministic builder would either re-introduce placeholder art or lie about reproducibility.
   Env-guarding the existing procedural writer + treating committed PNGs as source-of-truth is the
   honest minimal-churn option.
2. **Commit a fully byte-reproducible source compositor (seeds + vendored materials in-repo).**
   Rejected for this PR: the materials come from a hosted model; vendoring a reproducible material
   set is a larger, separate effort and was not needed to ship approved art. Left as possible future
   work.
3. **Lazy per-floor terrain-pack loading (load pack textures on floor entry, not at boot).**
   Rejected: `MainGameScene` bakes terrain in `create()`, so textures must already be resident;
   boot-time preload is the simplest correct point. Per-floor lazy loading is a larger renderer
   change with its own ordering hazards and no current need.

The reviewer concluded a genuinely different architecture was **not** warranted; the accepted plan
adopted the review's verification/documentation improvements within the same design.

## Follow-ups

- #1902 — wire the terrain-pack `doorSet` into the engine door overlay path.
- #1903 — Floor 2 harvestables, ambient lighting, and props for a lived-in feel.
