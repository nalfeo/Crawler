# Handoff — Post-processor interior-fill: enclosed-region cleanup for all sprite types

**Date:** 2026-07-28
**Branch:** `theme-equipment-interior-fill`
**Apples:** 3🍎 (tooling-only — sprite post-processor; no runtime gameplay/data changes)

## Systems touched

sprite-pipeline

## Problem

Generated equipment sprites (bows, rings, caps, collars) kept bright pink/blue
background fill inside **enclosed interior holes** — the ring centre, a bow's
inner curve, a cap's visor gap. The model paints the per-item generation
background colour (magenta / sky-blue / cyan / lime / yellow / orange from
`BACKGROUND_CANDIDATES`) into holes that the border-flood background removal can
never reach because they are sealed by foreground pixels.

Root cause: the `enclosed-regions` interior-background cleanup was gated to
`enemy`/`character` brief types only, through **two coupled gates**:

1. **Template gate** — `scripts/sprites/templates/base.yml` had
   `enabledForTypes: [enemy, character]` on the `enclosed-regions` module.
   `getActiveModules` (`template-pipeline.ts`) drops a module whose
   `enabledForTypes` excludes the sprite type, so the module was **absent** for
   weapon/item/equipment/prop.
2. **Runtime gate** — `postprocess.ts` computed
   `shouldRunEnclosedBackgroundCleanup` from the brief type. That flag is read by
   **both** the `enclosed-region-cleanup` handler **and** the post-resize
   `background-rekey` pass (`clearEnclosedIslands`) in `postprocess-modules.ts`.

Maintainer-chosen scope: interior cleanup should be **unconditional for every
sprite type except when explicitly disabled**.

## Change

- **`base.yml`** — removed `enabledForTypes: [enemy, character]` from the
  `enclosed-regions` module, so it is active for all sprite types by default.
  Updated the description to "Clean enclosed background islands (all types unless
  disabled, e.g. tiles/vfx)."
- **`vfx.yml`** — newly opts **out** of `enclosed-regions`
  (`modules: { enclosed-regions: { enabled: false } }`). VFX glow cores are
  frequently the same saturated colours used as generation backgrounds
  (cyan/yellow/orange), so cleanup would punch holes in the cores. This uses the
  maintainer-sanctioned "explicitly disabled" mechanism, alongside the
  pre-existing `tile.yml` opt-out.
- **`postprocess.ts`** — reordered so `pipeline` / `activeModules` /
  `disabledModules` are computed **before** the flag, then derived
  `shouldRunEnclosedBackgroundCleanup` from the **effective pipeline**:
  `enclosedRegionMode !== 'disabled' && activeModules has 'enclosed-regions' && !disabledModules.has('enclosed-regions')`.
  This ties **both** the module handler and the rekey pass to the same opt-out,
  so template `enabled:false`, template omission, runtime
  `disabledModules:['enclosed-regions']`, and the global
  `enclosedBackgroundMode:'disabled'` escape hatch all fully disable **both**
  cleanup passes.

## Why the derived flag matters (plan-review blocking concern)

The rekey pass previously read the type/mode flag and ignored
`disabledModules`, so a runtime `disabledModules:['enclosed-regions']` opt-out
leaked — the module was skipped but rekey still cleared enclosed islands.
Deriving the flag from the effective pipeline (module active **and** not
disabled) closes that leak. Covered by the
`honours the disabledModules opt-out: rekey must not clear the pocket either`
test.

## Double-pass parity decision

Rekey runs a **second** enclosed-island clear post-resize. A tiny region could
theoretically scale past `BACKGROUND_B_ENCLOSED_MIN_AREA` (4px) and be removed.
Accepted as **parity** with the already-shipping enemy/character path (both
passes ran there too). The pipeline **downscales** (large native gen → small
target), so the upscale-growth case is not the real path. The
`preserves a legitimate enclosed interior accent far from the background colour`
test proves a far-from-background interior feature survives **both** passes.

## Observe before done (rule #9)

The deterministic test `tests/unit/sprites/postprocess-enclosed-item.test.ts`
**is** the before/after proof, run through the **real** `postprocess` /
`postprocessWithTrace` pipeline (not a lab):

- **Before** (old gate): weapon/item/equipment did not run enclosed cleanup, so
  the sealed magenta pocket survived as opaque magenta in the output.
- **After**: the module-activity matrix asserts `enclosed-regions` is active for
  weapon/item/equipment/prop/enemy/character and absent for tile/vfx; the full
  weapon+equipment pipeline runs the `background-enclosed-regions` stage and the
  final sprite has **no opaque magenta**; the cleanup stage image itself shows
  the pocket centre at alpha 0. Opt-out and far-colour regressions are locked in.

`paletteMode:'none'` + nearest-neighbour resize make the assertions
deterministic: an uncleared magenta pocket stays exactly magenta, a cleared one
is fully transparent.

## Validation

- `npx vitest run --project sprites postprocess-enclosed-item` — 7 passing.
- `npx vitest run --project sprites postprocess bg-remove template-pipeline` — 58 passing (no regression).
- `npm run verify:fast` — green (371 tests).

## Review harness (3🍎)

- Plan review: separate model (gpt-5.6-sol), verdict minor-divergence, 4 concerns
  resolved, `plan_divergence: minor`.
- Code review: gpt-5.5 (distinct from plan reviewer + implementer).
- Ledger: `docs/knowledge/review-ledgers/2026-07-28-theme-equipment-interior-fill.review-ledger.json`.

## Follow-ups / notes for next agent

- If the maintainer wants VFX enclosed-hole cleanup after all, flip
  `vfx.yml`'s `enclosed-regions.enabled` back to true — but expect it to eat
  glow-core interiors that share a colour with the generation background.
- The `tile.yml` opt-out is unchanged by this fix.
