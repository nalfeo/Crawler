# Handoff: thorn-whip Floor 2 Equipment Icon

**Date:** 2026-07-18  
**Session:** Copilot Asset Forge — thorn-whip sprite pipeline  
**Apple estimate:** 1🍎 (art-only content generation)  
**PR:** nalfeo/Crawler#1401 (branch `copilot/asset-request-thorn-whip`)  
**Issue:** nalfeo/Crawler#1337 (Asset request: thorn-whip)  
**Aggregate tracking:** nalfeo/Crawler#1303

---

## Systems touched

- `briefs/weapons/thorn-whip.yaml` — new weapon brief (Floor 2 beam/whip class)
- `src/shared/items.ts` — added `thorn-whip` to ITEM_CATALOG (R rarity, Weapons tag)
- `plans/item-icons/weapons.art.yaml` — added art-plan entry for `thorn-whip`
- `tests/unit/items.test.ts` — updated catalog-size snapshots (+1 weapon, 127 total)

## What was done

1. **Plan posted** — replied to comment 5009100684 on issue #1337 with the full plan.
2. **Brief authored** — `briefs/weapons/thorn-whip.yaml`: vine whip with thorns, vertical
   orientation, 2 variation seeds, inherits weapon defaults (64×64, 4×4 sheet, VLM judge).
3. **Item wired** — added `wpn('thorn-whip', 'Thorn Whip', 'Vines that bite back.', R)` to
   `src/shared/items.ts`. `resolveItemSprite('thorn-whip')` will auto-resolve once the
   manifest has a `thorn-whip-var-N` entry.
4. **Art plan updated** — `plans/item-icons/weapons.art.yaml` now has a `thorn-whip` entry
   with `placeholderInUse: true`.
5. **Snapshots updated** — `tests/unit/items.test.ts` snapshot counts bumped to reflect
   new item (126→127 total, 23→24 weapons).
6. **Verify fast passed** — all 345 unit test files green.
7. **Branch pushed** — `copilot/asset-request-thorn-whip` (PR #1401).

## What still needs to happen

### Azure generation (blocker)

The `asset-request.yml` workflow was triggered for issue #1337 but was cancelled in a batch
cancellation at 2026-07-18T01:27:23Z (run #29625223304). It has not been re-triggered.

**To unblock:** The workflow must run again. Options:

- Maintainer (`nalfeo`) edits or reopens issue #1337 to fire an `issues.edited` / `issues.reopened` event
- OR: `gh workflow run asset-request.yml` from a machine with GitHub API access
- OR: Any other `asset-request`-labeled issue being updated will trigger the workflow, which then ingests ALL open asset-request issues including #1337 via `sprites:ingest-once`

The workflow (`.github/workflows/asset-request.yml`) will:

1. Ingest issue #1337 into the Azure queue
2. Run `sprites:worker` to generate variants using Azure OpenAI
3. Auto-approve the best-scoring variant
4. Push art to an `assets/thorn-whip-*` branch + file an `asset-checkin` issue

### After generation completes

5. **Asset PR** — `asset-pr` skill batches all `asset-checkin` issues into one art-only PR
6. **Observe** — confirm the icon renders correctly in `npm run dev` (InventoryUI + EquipmentUI)
7. **Close issue** — close #1337 once art is merged into `main`

## Design notes

- **Visual concept:** vine whip with hooked thorns, deep green vine body, acid-green thorn
  highlights, dark outline, faint bioluminescent glow accent on thorns (subtle).
- **Orientation:** vertical (grip bottom-center, tip at top) — weapon default, no override.
- **Runtime key:** `equipment/weapon/thorn-whip` (issue metadata notation); actual engine
  resolves via `resolveItemSprite('thorn-whip')` → manifest lookup by briefId.
- **Brief note:** the brief file is more detailed than the issue body brief sentence; the
  workflow uses the issue body. The brief file is available for local generation when
  Azure credentials are present.

## Before/After observation

Not yet observable — art generation has not run. The item renders as a procedural placeholder
in `InventoryUI` until `thorn-whip-var-N` appears in the manifest.

Expected after: the thorn-whip item in inventory/equipment screens shows a pixel-art vine
whip icon (64×64, green palette, vertical orientation).

---

_Conventional commit trail: ec4d412 "feat: add thorn-whip weapon brief, item catalog entry, and art plan"_
