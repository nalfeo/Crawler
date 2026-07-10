# ADR: Set-piece no-stretch contain-fit rendering, feet-based sizing, and honest custom placeholders

## Status

Accepted

## Date

2026-07-08

## Estimated Complexity

🍎 x 4 — cross-layer follow-up to ADR 0046: a new engine render contract
(contain-fit + flip), a feet-based sizing/placement schema dimension, core
stamp plumbing, a labs readiness-gate semantics change, and an agent-tooling
alias-aware regen ledger — no new `*System`, but five subsystems move together.

## Context

The Floor-1 `welcome-room` set piece shipped (ADR 0046: mapgen integration +
NPC placement + prop layering; sprite wiring in #907). A maintainer art-defect
review of the rendered room surfaced hard problems the layering work did not
address:

1. **Sprites stretched.** Props were scaled to fill their tile footprint,
   distorting aspect ratios. The maintainer's constraint is absolute: **"we have
   designed NO tiles to stretch."** A stretched sprite is never acceptable, even
   to fill a gap.
2. **No physical size language.** The schema had no way to say "this desk is
   4 ft wide"; sizing was implied by tile count, so a sprite's real proportions
   and its footprint were unrelated — the root cause of the stretch.
3. **Wall decor on the floor.** Sconces rendered at floor level with no
   consistent way to pin/orient wall-mounted decor.
4. **Wrong-tile Kenney decor shipped as if final.** Three decor props reused the
   nearest Kenney atlas frame (a potted plant, a side table, a stool) that did
   not match the intended object. These masqueraded as finished art instead of
   being tracked as missing.
5. **The visual judge re-critiqued already-queued assets.** The `--art-review`
   judge had no durable memory, and the vision model labels the same defect
   inconsistently (`welcome-banner` vs `welcome-sign` vs `welcome-sign.text`),
   so an alias-labeled finding created a duplicate ledger entry and re-flagged an
   asset already queued for regeneration.

## Decision

1. **No-stretch contain-fit + flip (engine).** `PhaserBridge` renders each
   set-piece sprite with **aspect-preserving contain-fit** into its target box
   (scale by `min(boxW/texW, boxH/texH)`), plus optional `flipX`/`flipY`.
   Sprites never stretch; they letterbox within their footprint. Missing or
   `source:'custom'` sprites draw an honest labeled placeholder rectangle instead
   of a wrong texture.
2. **Feet-based per-layer sizing + placement anchor (shared schema).** Add
   `widthFt`/`heightFt`/`offsetXFt`/`offsetYFt` and `flipX`/`flipY` to each render
   layer, and a set-piece-level `placement` anchor (`verticalAlign` /
   `horizontalAlign`) so the whole piece can be pinned within a room. Feet are the
   single physical unit (1 tile = 4 ft), converted to pixels at render time.
   Fields are **optional** and zod-validated, so existing set-piece entries
   without them keep validating and rendering.
3. **Stamp threads the new geometry (core).** `stampSetPiece` carries feet
   sizing, per-layer offset/flip, and the placement origin through deterministic
   tile-space stamping, fitted/clamped to room bounds.
4. **Honest custom placeholders + asset queue (content).** The three wrong-tile
   Kenney props are converted to `source:'custom'` (a `CustomSpriteRef` that
   renders as a labeled placeholder) and their art is queued in the asset request
   queue. The room shows an honest "art pending" box, never a mismatched sprite.
5. **Alias-aware, curated regen ledger (agent tooling).** Extract the ledger
   dedup/suppression into a pure module `scripts/agent/review/art-ledger.ts`
   (`normalizeAssetKey`, `entryMatchKeys`, `suppressedAssetKeys`,
   `mergeAssetFindingsIntoLedger`). Each entry may declare **curated** `aliases`;
   a finding matching an entry's asset **or any alias** bumps that entry instead
   of appending a duplicate, and suppression unions all needs-regen keys+aliases
   so a queued asset is not re-critiqued. Aliases are authored into the ledger
   (curated), **not** auto-inferred from novel labels. The judge also stores
   GOOD/BAD image evidence for later judge tuning. The ledger load is
   **fail-closed**: a _missing_ file maps to an empty first-run ledger, but a
   _present-but-corrupt_ file (bad JSON, non-object root, non-array `assets`)
   throws rather than silently degrading to an empty suppress-list. Suppression
   applies across **all** finding arrays (`asset_findings`, `blocking_findings`,
   `recommended_fixes`, `precise_fixes`) via token-boundary text matching, while
   deterministic blocking findings are never suppressed.
6. **Readiness gate accepts intentional placeholders (labs).** The set-piece-lab
   honest-ready gate counts **intentional** persistent placeholders via
   `expectedPersistentPlaceholderCount`, so a room that deliberately ships N
   custom placeholders reaches `ready:true` (fixing a cold-cache race where the
   gate never flipped) without hiding an _unintended_ broken render. The liveness
   guard is `imageCount === 0 && placeholderRectCount === 0` so a **pure**-
   placeholder piece (no image layers at all) still flips ready once its stand-in
   rects render, instead of hanging forever.

## Consequences

### Positive

- No set-piece sprite can stretch — the maintainer's hard constraint is enforced
  in the render path, not by per-asset authoring discipline.
- Props are sized in real feet, so a sprite's proportions and its footprint are
  independent and correct by construction.
- Missing/wrong art is visibly honest (labeled placeholder) and tracked in the
  asset queue, so it cannot silently ship as final.
- The judge has durable, alias-aware memory: a queued defect is not re-flagged
  across runs regardless of how the vision model relabels it.
- The readiness gate deterministically reaches ready for rooms with intentional
  placeholders, unblocking the review capture.

### Negative

- One more render contract (contain-fit + flip) and a feet-sizing dimension to
  keep in mind when authoring set pieces.
- Curated aliases must be authored by hand when the vision model invents a new
  label for an already-queued asset.

### Risks

- **Under-sized feet dims** could letterbox a sprite into a sliver. Mitigated by
  unit tests asserting every hero furniture prop has a positive feet box, and by
  the contain-fit guarding against zero/undefined dims.
- **`expectedPersistentPlaceholderCount` could mask a real broken render** if set
  too high. Mitigated by keeping it an explicit authored count matched to the
  known custom props, and by unit tests on the readiness gate.
- **Curated-alias drift**: a brand-new model label for a queued asset re-flags
  once until an alias is added. Accepted as low-cost and auditable versus
  fuzzy/auto-inference false-positives.

## Alternatives Considered

- **9-slice / stretch-to-fill (rejected for D1):** 9-slice needs authored slice
  guides per sprite the project does not have, and any stretch violates the hard
  no-stretch constraint. Contain-fit preserves aspect with zero per-asset config.
- **Cover-fit / clamp-and-crop (rejected for D1):** filling the box by cropping
  hides art (cuts off sprite edges) — the maintainer explicitly flagged cut-off
  sprites as a defect. Contain-fit shows the whole sprite.
- **Pixel- or tile-count sizing (rejected for D2):** pixels couple content to a
  texture's resolution; tile-count is exactly the implied sizing that caused the
  stretch. Feet are a resolution-independent physical unit shared with the
  4-ft-tile grid.
- **Reuse the nearest Kenney tile (rejected for D3/D4):** ships a wrong object as
  if final and leaves no queue signal. Honest placeholders make the gap visible
  and trackable.
- **Auto-infer aliases from novel vision labels (rejected for D5):** a truly
  novel label cannot match any existing entry on first sight, so auto-recording
  is dead code plus a false-merge risk. Curated aliases are deterministic and
  auditable.
- **Fuzzy string matching for ledger dedup (rejected for D5):** substring/edit-
  distance matching risks collapsing two genuinely different assets. Exact
  normalized key + curated alias set is predictable.
- **Fail-open ledger load (rejected for D5):** silently returning an empty
  ledger on any read error would let a corrupt suppress-list quietly re-flag or
  under-flag assets with no signal. Fail-closed (throw on corrupt, tolerate only
  a genuinely missing file) surfaces the problem loudly while preserving the
  first-run experience.
- **Suppress only `asset_findings` (rejected for D5):** the vision model restates
  the same queued defect in `blocking_findings` / `recommended_fixes` /
  `precise_fixes`, so array-scoped suppression re-critiques a queued asset through
  another array. Cross-array token-boundary suppression (with deterministic
  blockers exempt) matches the "don't re-critique queued art" requirement.
- **Treat any placeholder as not-ready (rejected for D6):** would make a room
  with intentional queued placeholders never reach ready, blocking review capture
  forever. The explicit expected-count preserves the honest-ready guarantee for
  _unintended_ placeholders.

## Relationship to prior ADRs

Builds on **ADR 0024** (set-piece themed rooms) and **ADR 0046** (set-piece
mapgen integration + NPC placement + layering). It does not supersede them; it
extends the set-piece render contract (no-stretch contain-fit, feet sizing,
placement anchor) and adds the honest-placeholder + alias-aware-judge policy on
top of the shipped system.
