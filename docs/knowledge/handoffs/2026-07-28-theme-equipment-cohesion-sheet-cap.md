# Theme-equipment collection-cohesion contact sheet cap fix

**Date:** 2026-07-28
**Branch:** `theme-equipment-cohesion-sheet-cap`
**Apples:** 3🍎 (tooling-only; asset-pipeline tooling, no runtime gameplay/data change)

## Systems touched

sprite-pipeline

## Problem

The theme-equipment set pipeline's **collection-cohesion vision judge** runs at the
end of the `sprite-sheets` and `variant-approval` phases. It composites one contact
sheet of tiles and asks a vision model whether the whole set reads as a single
coherent collection. At `variant-approval` the old code assembled **one tile per
approved variant per item** — for the live set `classic-fantasy-basic-leather` that
was 18 items × 3 approved variants = **54 tiles**, which overflowed
`CONTACT_SHEET_MAX_TILES` (32) and threw `buildThemeEquipmentContactSheet` at the
very end of a ~60-minute paid run. The crowded sheet also made the vision judge
hallucinate defects (maintainer reported the judge calling matte iron "polished" and
a bow "too fancy for being curved").

## Fix (maintainer-approved "Option A")

Use **one representative image per item**. Collection cohesion is a cross-item
judgment; per-variant quality was already judged during variant approval. One tile
per item caps the sheet at item-count (≤18, never ×variants) and keeps each sprite
large enough for the vision model to read.

- `scripts/sprites/theme-equipment-runner.ts`
  - `judgePhaseCollection` (~528) now delegates tile selection to a new exported
    `selectCollectionTileSources(state): CollectionTileSource[]` (~742). roster/briefs
    still route to the **text** judge (zero images); only `sprite-sheets` /
    `variant-approval` reach the vision judge.
  - `selectCollectionTileSources` returns exactly one tile per item in `state.items`
    order:
    - `sprite-sheets` → the item's `raw-sheet` artifact (unchanged granularity —
      this phase already did one tile/item; the refactor just centralizes it).
    - `variant-approval` → the approved-variant with the **lowest `variantIndex`**
      (deterministic tiebreak independent of the durable artifact array's order;
      `?? Number.POSITIVE_INFINITY` so index `0` is selectable). Scores are not
      durable metadata, so a "highest score" pick would need fragile evidence-JSON
      parsing — rejected.
  - Validates `briefId` / `runId` / (`variantIndex` | `summary`) on **every** approved
    artifact before selection, so a malformed unselected artifact fails loudly here
    rather than surviving to publish. Throws `ThemeEquipmentRunnerError` for an
    unsupported phase, an item with no approved variants, or incomplete metadata.
  - Processed-image store key: `${briefId}/${runId}/processed/${padStart(2,'0')}.png`
    — confirmed byte-for-byte against the write path
    (`theme-equipment-runner.ts:493`) and the CLI read path
    (`theme-equipment-review-cli.ts:603`).

`CONTACT_SHEET_MAX_TILES = 32` is **unchanged** — it stays a real safety net, and its
pipeline cap tests remain valid.

## Tests

`tests/unit/sprites/theme-equipment-runner.test.ts` (run:
`npx vitest run --project sprites theme-equipment-runner`):

- `selectCollectionTileSources` pure tests: one tile/item at variant-approval with
  the lowest-index representative; validates **every** approved artifact (a malformed
  _unselected_ variant still throws); throws for no-approved-variants and for
  unsupported phases; one `raw-sheet` tile/item at sprite-sheets.
- Runner wiring test: seeds a coverage-valid variant-approval state (all items
  `up`, out-of-order variant indices), runs the phase, and asserts the judge fetched
  **exactly item-count** processed tiles (the representatives only — never the
  non-representative variants), saved once, and never regenerated. This test would
  FAIL against the old per-variant behavior (it fetched N×variants).

## Observe before done

- **Before (broken):** run **30338459241 / 30339239243** (earlier dispatches) failed
  at the `buildThemeEquipmentContactSheet` >32-tile assertion at the end of the
  variant-approval collection judge.
- **After (fix):** run **30395866538** (`gh workflow run theme-equipment.yml --ref
theme-equipment-cohesion-sheet-cap -f action=run-phase -f
set_id=classic-fantasy-basic-leather`) dispatched from this branch and executing
  the real `variant-approval` phase → collection judge with the one-tile-per-item
  selector. Monitor and confirm it reaches the collection judge without the tile-cap
  throw. (Report in the `theme-equipment-review` canvas + the Actions run URL.)

## Edge / out of scope

A set with **>32 items** would still overflow the 32-tile cap even at one-tile-per-item
(current sets ≤18; there is no contact-sheet pagination). Not handled here — it
degrades **safely** by throwing `buildThemeEquipmentContactSheet`'s cap error rather
than silently truncating. A future change could paginate the collection judge across
multiple sheets if larger sets are authored.

## Review

3🍎 review harness complete — ledger
`docs/knowledge/review-ledgers/2026-07-28-theme-equipment-cohesion-sheet-cap.review-ledger.json`
(`validate` exit 0):

- `plan_review`: gpt-5.6-sol, `plan_divergence: minor`, 4/4 concerns resolved.
- `code_review`: gpt-5.5 (distinct model), round 1 clean, 0 actionable code concerns.
