# ADR 0018: Unify sprite sheet slicing on the content-aware path

## Status

Accepted

## Date

2026-06-25

## Estimated Complexity

🍎 x 4 — multi-subsystem (slicer + sidecar `/api/slice-map` + devtools/tests),
ADR required, but no new ECS system and no new lab.

## Context

The sprite-sheet slicer (`scripts/sprites/slice-sheet.ts`) shipped **two**
different algorithms inside one function (`computeSliceMapV2`), branched on
whether the caller passed `rows`/`cols`:

- **Equal-division grid** — when `rows`/`cols` were supplied, the sheet was cut
  into a fixed `rows × cols` grid at uniform intervals.
- **Content-aware band detection** — when only `emptyCells` was supplied, the
  slicer scanned for entirely-background rows/columns ("bands") and cut at each
  interior band's centre, tolerating sprites of slightly different sizes.

The two production callers diverged:

- **Generation** (`generate-one.ts` → `sliceSheetFromBrief`) passed the brief's
  declared `rows`/`cols`, taking the **equal-division** path.
- **Post-process debugger** (`/api/slice-map`) passed only `{ emptyCells }`,
  taking the **content-aware** path.

For the same generated sheet this produced **different cell boundaries**. When a
model laid sprites out unevenly (variable size, off-grid centring), equal
division sliced through sprite bodies — so the **workflow grid thumbnails the
user reviews showed garbage**, while the **debugger preview and the final
committed catalog sprite looked clean** (approve re-runs a clean path). The
review UI no longer reflected what would ship, eroding trust in the workflow.

A secondary drift risk: the background-removal tolerances used during generation
(`BACKGROUND_B_COLOR_TOLERANCE_SQ` / `BACKGROUND_B_FRINGE_TOLERANCE_SQ` in
`postprocess.ts`) must equal the devtools debugger defaults
(`DEFAULT_BACKGROUND_TWEAKS` in `src/devtools-main.ts`) or the previews diverge
for a second reason. They were equal (4000 / 12000) but nothing enforced it.

## Decision

**Delete the equal-division algorithm entirely. There is now exactly one
slicer: content-aware band detection.**

- Removed all v1/equal-division code from `slice-sheet.ts` (`computeSliceMap` v1,
  `sliceSheet` v1, `inferRowOffsets`/`inferColOffsets`, foreground-count helpers,
  the `rows`/`cols` branch, and the `rows`/`cols` fields on `SliceOptions`).
- Renamed the surviving V2 symbols to canonical names:
  `computeSliceMapV2 → computeSliceMap`, `sliceSheetV2 → sliceSheet`,
  `SliceOptionsV2 → SliceOptions`.
- `sliceSheetFromBrief` now calls `sliceSheet(sheetPng, { emptyCells })` — it no
  longer forwards the brief's `rows`/`cols` for slicing. The brief grid remains a
  layout hint for the image-provider prompt only.
- The sidecar `/api/slice-map` handler reports `algorithm: 'content-aware'`
  (was `'v2'`); generation and the debugger now call the identical code path, so
  the variants the debugger previews are byte-for-byte what generation produces
  and what `approve` ships.
- **Locked the post-process background defaults** with a guard test in
  `tests/unit/bg-remove.test.ts` asserting `BACKGROUND_B_COLOR_TOLERANCE_SQ === 4000`
  and `BACKGROUND_B_FRINGE_TOLERANCE_SQ === 12000`, plus a cross-reference comment
  on `DEFAULT_BACKGROUND_TWEAKS` in `src/devtools-main.ts`.

## Consequences

### Positive

- Workflow grid, debugger preview, and final catalog output are produced by one
  code path — they cannot diverge for the same sheet.
- A single slicer to maintain and test; the brief grid becomes a pure prompt
  hint, decoupled from slicing.
- The background-tweaks guard test prevents silent option drift between
  generation and the debugger.

### Negative

- The brief-declared grid is no longer authoritative for slicing. A sheet whose
  sprites the model renders touching with no background gutter could
  under-segment. This is mitigated by the existing `bad-grid` guard in
  `generate-one.ts`, which still requires exactly `variantCount(brief)` cells and
  retries otherwise.
- Equal division as an explicit fallback is gone; gutterless sheets rely on the
  retry rather than a fixed grid.

### Risks

- Content-aware slicing assumes background gutters between sprites. The PR #164
  edge-touch concern (1px-edge cells failing `opaque-bbox-fits`) was re-evaluated
  and does **not** trigger with the current fixtures: all 25 integration tests
  pass with zero fixture changes. A future provider emitting gutterless sheets is
  caught by the `bad-grid` retry.

## Alternatives Considered

- **Keep both paths; make generation pass content-aware options.** Rejected —
  leaves dead equal-division code as a latent divergence source, and the user
  explicitly asked to delete the old method.
- **Make the debugger use equal-division to match generation.** Rejected —
  equal-division is the buggy path; content-aware is the modern, correct one.
- **Extract a shared background-tweaks constant module imported by both
  devtools and postprocess.** Rejected — `src/devtools-main.ts` is a browser
  bundle and must not import Node/pngjs code from `scripts/sprites`. Locked via a
  Node-side guard test + cross-reference comment instead.
