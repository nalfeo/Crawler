# ADR 0052: Slicer cuts only at real gutters — data-driven grid salvage

## Status

Accepted

## Date

2026-07-08

## Estimated Complexity

🍎 x 4 — multi-subsystem (slicer `slice-sheet.ts` + generation gate
`generate-one.ts` + re-run carry-forward guard `rerun.ts`), reverses a prior
product decision, ADR required. No new ECS system, no new lab (build-time
tooling only).

## Context

A human bug report: **"the slicer is chopping things off on the right side a
lot."** Reproduced deterministically on the real `welcome-room-shop-table-v2`
sheet — a wide 3:1 sheet whose brief carried no `generation.sheet` block, so the
commanded grid defaulted to 4×4. The model actually drew a clean **5×3** of
tables. Forcing the commanded 4 columns put three interior cut lines straight
through all 15 tables: an integer-math pixel probe measured **1806 foreground
pixels lying on interior cut lines**, versus **0** for the content-aware honest
5×3.

The cause was the reconciliation added by the **2026-07-07 grid-reconciliation
decision** (`docs/knowledge/review-ledgers/2026-07-07-slicer-grid-reconciliation.review-ledger.json`,
handoff `docs/knowledge/handoffs/archive/2026-07-07-slicer-variance-select-grid.md`).
That change targeted the opposite symptom — **over**-segmentation (a gappy
rubble sheet detected 20 cells for a commanded 16 and hard-failed the count
gate). Its fix:

- **Over-segmented axis** → pick the `(commanded−1)`-subset of the real detected
  gutters minimizing Σ(cell-width²) (`selectEvenCuts`, a variance DP).
- **Under-segmented axis** → **fall back to blind uniform cuts.**
- Reconciliation **always emits the commanded cell count**; human gallery review
  is the grid-quality gate.

The over-segmentation half is sound. The **under-segmentation `uniformCuts`
fallback is the chopping bug**: when the model draws fewer columns/rows than
commanded, uniform division invents cut lines with no real gutter beneath them,
severing whatever art sits there — reliably the right/bottom edge on wide or
tall sheets. "Always emit the commanded count" is what forced that invention.

This is fundamentally the tension ADR 0018 flagged as its one Negative: once the
brief grid is no longer authoritative for slicing, a mismatch between commanded
and drawn layout must be resolved _somehow_. 0018 resolved it with a hard retry;
0707 resolved it by forcing the grid (and chopping); this ADR resolves it by
trusting the sheet.

## Decision

**The slicer cuts ONLY at real detected gutters and never invents a cut. The
emitted grid and variant count are data-driven — read from the sheet, not
forced from the brief. The brief grid is a soft anchor/tiebreak only.** This is
"Option A — SALVAGE", chosen explicitly by the human over "Option B —
force-regenerate".

Three subsystems change together:

1. **`scripts/sprites/slice-sheet.ts`** — new `chooseAxisCuts` per axis:
   - Detect real gutters (unchanged content-aware band detection).
   - **Trim runt edge cells first** (`trimEdgeRunts`): a leading/trailing
     row/col far below the median cell size is an incomplete partial sprite the
     model tacked on — the literal "chopped edge". `n==2` trims the smaller edge
     only when `min*2 < max`; `n≥3` trims an edge when
     `tooSmall = size*5 < median*3` **and** its neighbour is full-size **and
     not** a `phantomHalf` (`|size+nbr−median|*5 <= median*2`, i.e. a real
     sprite the detector split in two — merge, don't trim).
   - **Search only `k ≤ detected` cut counts** and keep the subset that
     maximises same-sized sprites. `betterAxisScore` orders candidates:
     (1) regular-cell count DESC (cells within ±40% of the lower-median size),
     (2) |cells − commanded| ASC (the brief as a soft anchor), (3) size
     dispersion ASC, (4) cell count DESC. Candidate cut subsets reuse the 0707
     `selectEvenCuts` variance DP. **Because `k` never exceeds the number of
     real gutters, the slicer can never invent a cut through art.**
   - Return the honest result: new exported `BriefSliceResult
{ cells: Buffer[]; grid: { rows; cols; emptyCells }; variantCount }` from
     `sliceSheetFromBrief` / `sliceSheetWithGrid`.
   - **The bare debugger/gallery path is byte-identical.** `computeSliceMap`
     called without an `expectedGrid` (the `/api/slice-map` handler in
     `scripts/sprites/sidecar/server.ts` and the gallery) is untouched, honoring
     ADR 0018's single-code-path guarantee for that surface.

2. **`scripts/sprites/generate-one.ts`** — the count gate is **relaxed from
   `cells.length === variantCount(brief)` to `cells.length === 0`.** A clean
   data-driven grid at its honest count is accepted and carried to human gallery
   review; only a slice that produces _nothing_ is a hard failure. Generation
   persists the ACTUAL `grid` and `variantCount` in the run summary (not the
   brief's commanded values).

3. **`scripts/sprites/rerun.ts`** — the re-post-process carry-forward guard
   (ADR 0024) can no longer compare "brief-then vs brief-now", because the grid
   is now data-driven. It **anchors on the run's persisted actual grid**:
   - _Modern_ runs (grid persisted): re-slice the stored sheet with
     `sliceSheetWithGrid(sheet, persistedGrid)` and reject if the reproduced
     rows/cols/emptyCells differ — the real corruption signal (a corrupt
     persisted grid, or the slicer changed since generation).
   - _Legacy_ runs (no persisted grid): fall back to `sliceSheetFromBrief` + a
     variant-count check against `summary.variantCount`, then **backfill
     `summary.grid`** on success so the next re-run takes the modern path.

The relaxed count gate is a **deliberate, documented product reversal per the
human's directive — not a gate weakened to make a test pass** (project rule #12).
Human gallery review remains the grid-quality gate, exactly as 0707 established;
this ADR only removes the art-destroying way 0707 reached the commanded count.

## Consequences

### Positive

- The slicer never cuts through foreground art on the generation path. The
  reported "chopped right side" class of bug is eliminated at the root:
  1806 → 0 foreground pixels on interior cuts for the repro sheet.
- Grid/count follow what the model actually drew. A brief whose commanded grid
  is wrong (missing `generation.sheet`, or an off-by-one) no longer corrupts the
  crop — it is salvaged and surfaced honestly for review.
- Runt-edge trimming removes the incomplete partial sprites models tack onto an
  edge, which were the visible half-sprites in review thumbnails.
- The honest `grid`/`variantCount` persisted per run makes the re-run guard
  precise (structure-exact), and gives a truthful count to downstream review.

### Negative

- The brief-declared variant count is no longer enforced at generation time. A
  sheet that legitimately should have had N variants but slices to M is accepted
  and relies on **human gallery review** to catch it (this is the 0707 posture,
  now the sole grid gate rather than a backstop behind a hard count).
- A run's summary now carries a `grid` field that older tooling did not write;
  the re-run guard tolerates its absence (legacy fallback) but other future
  consumers must treat `grid` as optional.

### Risks

- **Legacy re-run migration.** Runs generated under the 0707 force-count path
  recorded the commanded count, which may differ from what the current slicer
  produces for the same stored sheet. Re-post-processing such a run now fails
  with `variant-count-mismatch` (the legacy fallback) instead of silently
  overwriting the wrong per-variant entries. This is correct and safe — the
  operator regenerates the run to adopt the current slicer — but it is a
  behavior change for old runs, mitigated by the on-success `summary.grid`
  backfill so it only bites once.
- **Under-segmentation is now trusted, not forced.** If content-aware detection
  genuinely misses a real gutter (sprites touching with no background band), the
  slicer under-counts rather than inventing a cut. That is the intended
  trade — an honest merged cell surfaced for review beats a cut through art —
  but it shifts the residual failure mode from "chops art" to "occasionally
  merges two sprites", which the human gallery catches.

## Alternatives Considered

- **Option B — keep the hard count gate; force-regenerate on mismatch.**
  Rejected by the human: it keeps the commanded count authoritative, so it
  either re-introduces the uniform-cut chopping or burns Azure regenerations on
  sheets that are already fine. The whole point is that the drawn layout, not
  the brief, is ground truth.
- **Keep 0707's "always emit commanded count" and only fix the under-seg
  branch to snap to detected gutters.** Rejected — you cannot emit the commanded
  count from fewer real gutters without inventing a cut; the count itself has to
  become data-driven.
- **Add the emitted `grid` to the `SliceMap` returned by the bare
  `computeSliceMap`.** Rejected — it would change the `/api/slice-map` debugger
  response contract that ADR 0018 unified and that
  `scripts/sprites/sidecar/server.ts` depends on being byte-stable. The
  data-driven grid is returned only from the brief-aware `BriefSliceResult`,
  leaving the bare path untouched.
- **`betterAxisScore` ordering dispersion-before-anchorDelta.** Rejected during
  adversarial plan review — anchoring on dispersion before the soft
  commanded-count delta collapses irregular-but-real grids toward `k=1`; the
  regular-cell-count-first, then anchor-delta ordering keeps honest dense grids.

## Relationship to prior ADRs

- **ADR 0018** (unify slicing on the content-aware path) — this ADR upholds
  0018's single-slicer principle for the bare debugger path and restores its
  spirit that the brief grid is not authoritative for cuts, while replacing
  0018's hard `bad-grid` retry with data-driven salvage.
- **2026-07-07 grid-reconciliation decision** (ledger-only, no ADR) — this ADR
  **reverses** its "under-segmented axes fall back to uniform cuts" and "always
  emit the commanded count" halves, and **retains** its `selectEvenCuts`
  variance DP (now a candidate generator inside the `k ≤ detected` search) and
  its "human gallery review is the grid gate" posture.
- **ADR 0024** (re-run carry-forward guard) — this ADR re-bases that guard on
  the persisted actual grid instead of the brief.
