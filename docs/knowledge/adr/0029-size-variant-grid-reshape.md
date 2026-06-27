# ADR 0029: Size variants reshape the sheet grid (fixed canvas)

## Status

Accepted

## Date

2026-06-27

## Estimated Complexity

🍎 × 4 (Large) — touches the generation pipeline (size-variant transform + prompt
builder), the DevTools workflow UI, and the sidecar synthesize endpoint, plus
their unit tests. No new ECS system / lab.

## Context

A "wide (2×1)" sprite request produced **two** sheets of **sixteen square**
sprites instead of **one** sheet with **eight double-width** options. Two
defects compounded:

1. **No authoring control.** The DevTools sprite-workflow composer exposed only
   name / brief / type. There was no size selector, and the `sizeVariant` field
   was never sent to the sidecar `POST /synthesize`, so a wide brief could only
   be produced by hand-editing YAML.
2. **The grid never reshaped.** The size-variant transform
   (`applySizeVariantToDefaults`, introduced with the `--size` CLI flag) scaled
   `size`/`anchor` and _inflated_ `nativeCanvas` 1024→2048, but kept the 4×4 =
   16 **square** grid. A wide brief therefore still asked the model for 16
   square cells. The content-aware slicer then disagreed with the expected
   variant count, failed the slice gate, and the generator retried — leaving two
   stored sheets (`sheet-00`, `sheet-01`).

The original `--size` design kept square cells and grew the canvas; that choice
was never recorded in an ADR and is the root of the mismatch.

## Decision

A size variant **reshapes the sheet grid on a fixed 1024² canvas** rather than
inflating the canvas while keeping square cells. The grid axes are divided by the
per-axis multiplier, so a bigger cell means proportionally fewer cells and the
sheet holds a **fixed pixel budget**:

| variant | mult (w×h) | grid (rows×cols) | cells | cell px | output px | downscale |
| ------- | ---------- | ---------------- | ----- | ------- | --------- | --------- |
| default | 1×1        | 4×4              | 16    | 256×256 | 64×64     | 4×        |
| wide    | 2×1        | 4×2              | 8     | 512×256 | 128×64    | 4×        |
| tall    | 1×2        | 2×4              | 8     | 256×512 | 64×128    | 4×        |
| large   | 2×2        | 2×2              | 4     | 512×512 | 128×128   | 4×        |

`cols ÷= mult.width`, `rows ÷= mult.height` (floored at 1); `nativeCanvas` is
left untouched. Every cell now matches the output aspect ratio, every combo keeps
a clean 4× integer downscale, and `1024` stays divisible by all reshaped grids so
the brief schema's divisibility check passes.

The prompt builder (`build-prompt.ts`) becomes **aspect-aware**: the sheet-layout,
output-size, and per-variant blocks no longer hard-code "perfectly square" cells;
for wide/tall they describe a landscape/portrait rectangle of the exact cell
dimensions. The DevTools composer gains a size dropdown that threads
`requestedSize` through the workflow queue and into the synthesize request; the
sidecar validates `sizeVariant` against `SIZE_VARIANTS`.

## Consequences

### Positive

- A wide request yields exactly one sheet of 8 double-width options — the
  behaviour the operator expected.
- Cell aspect matches subject aspect, so subjects no longer letterbox inside a
  square cell, and the slice gate stops spuriously failing/retrying (fewer
  orphan `sheet-NN` artifacts).
- A fixed 1024² canvas keeps the provider request square and removes the
  canvas-inflation / 2048-divisibility coupling entirely.
- Size is now a first-class authoring control in the UI, not a YAML hand-edit.

### Negative

- `large` yields only 4 options per sheet (the inverse-area consequence of a
  fixed budget). Acceptable: the operator asked specifically about `wide`, and a
  re-generate is cheap; documented here so it is not a surprise.
- Briefs authored against the old behaviour (expecting a 2048 canvas with 16
  square wide cells) change shape. No committed brief sets `sizeVariant`, so
  there is nothing to migrate.

### Risks

- The model may still occasionally lay out a non-grid sheet; the slice gate +
  retry remains the backstop. The clearer aspect-matched prompt is expected to
  reduce, not eliminate, bad layouts.

## Alternatives Considered

- **Keep square cells, inflate the canvas (the prior `--size` behaviour).**
  Rejected: it produced 16 square cells for a "wide" request (the bug), forced
  the 2048 divisibility coupling, and letterboxed non-square subjects.
- **Inflate to 2048 _and_ reshape to keep 16 wide cells (8 cols? no — 16 wide
  cells = 2048×1024 non-square canvas).** Rejected: a non-square canvas
  complicates the provider request and the slicer for no benefit; the operator
  explicitly wanted _fewer, larger_ options, not the same count at higher res.
- **Add the UI selector only, leave the grid square.** Rejected: it would let an
  operator pick "wide" and still get 16 square cells — the selector would
  "not work" exactly as reported.
