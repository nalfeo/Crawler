# Session Handoff: alchemist-goggles brief authored, generation pending CI

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

- `briefs/items/alchemist-goggles.yaml` (new)
- `plans/item-icons/equipment-gear.art.yaml` (added alchemist-goggles entry)

## Apples

1🍎 estimated (art-only; brief authoring phase — generation pending CI; review-ledger-exempt per two-PR-lane policy)

## What Was Done

Authored `briefs/items/alchemist-goggles.yaml` for issue nalfeo/Crawler#1376 (Floor 2 head-slot
equipment icon, production wave `floor2-equipment-ui-head`, stable ID `head.alchemist-goggles`,
runtime key `equipment/head/alchemist-goggles`).

**Brief design decisions:**

- `type: item` — inherits `data/sprite-types/item.json` defaults: 64×64, kenney-roguelike
  palette, 4×4 sheet (16 variants), `judge.enabled: true`, anchor `(32, 56)`.
- `floor: 2` — sets creative-intensity context for retro-futurist corporate-decay aesthetic.
- Visual concept: oversized dual-lens alchemist goggles, face-on view. Brass/copper rims with
  heavy verdigris patina, scratched dark amber/green-grey tinted lenses, riveted bridge, worn
  leather strap. Floor 2 industrial aesthetic (dungeon lab salvage, not fantasy forge).
- `sensors.edge.allowMainTouch: true` — goggles are wide; the outer rim of the round lenses
  will naturally reach near the frame edge at 64×64.
- `minVariations: 5` for healthy diversity headroom.
- 3 variation seeds covering: verdigris-heavy brass, dark-iron frames with hex bolts,
  copper-toned with bent rim.
- Explicitly excluded: glow, magical aura, visible eyes behind lenses. Clean equipment icon,
  no scene props.

**Brief authored at:** `briefs/items/alchemist-goggles.yaml`

**Art-plan entry added to:** `plans/item-icons/equipment-gear.art.yaml`
(status now shows `brief-ready-placeholder` in `sprites:asset-plan`; integration
tracks the item catalog entry `alchemist-goggles`, which is the runtime item-art
consumer for equipment icons)

**Generation attempt:** `npm run sprites:run -- --brief briefs/items/alchemist-goggles.yaml`
failed with `Missing required env var 'AZURE_OPENAI_ENDPOINT'`. This is expected — Azure
credentials are intentionally not available to the coding-agent runner (scoped only to the
`asset-request.yml` workflow steps). AGENTS.md "Azure-required sidecar policy" §5 correctly
blocked silent fallback.

**CI pipeline:** The `asset-request.yml` GitHub Actions workflow is triggered on `issues:
labeled` events. Issue #1376 carries the `asset-request` label — the workflow will (or has
already) ingested the issue, synthesized/queued a brief, and run the drain worker with Azure
secrets to generate the sprite. The worker uses `SPRITES_ALLOW_CI_PIPELINE: 'true'` to bypass
Constitutional §3 for synth+judge only.

**Observed in real artifact:** N/A — generation did not complete in this session (Azure
credentials intentionally unavailable to coding-agent runner).

## Key Decisions Made

- Brief name `alchemist-goggles` (bare ID), not `equipment/head/alchemist-goggles` (full path).
  The manifest uses the full path as `briefId` for the placeholder
  (`"briefId": "equipment/head/alchemist-goggles"`), but the manually-authored brief follows the
  same pattern as `iron-greaves.yaml`, `gearwork-locket.yaml`, etc. — bare name only. The
  ingester/worker may use a different naming convention; if it does, the brief here still serves
  as the human-authored design spec for the subject.
- The art-plan integration target is `item-catalog: alchemist-goggles`, not
  `sprite-registry`, because equipment/item icon readiness is consumed through
  `resolveItemSprite(itemId)` rather than a sprite-registry ID.
- `allowMainTouch: true` because goggles are inherently wide — the outer lens rim extends toward
  the frame edge, which is correct composition, not an error.
- No anchor override needed — item type default `(32, 56)` is appropriate for headgear sitting
  grounded in the lower portion of the frame.
- Silhouette description prioritized: "two large circles side by side with a connecting bridge"
  — easy to sketch mentally at 64×64.

## What Needs to Happen Next

1. **CI generation** — the `asset-request.yml` workflow processes issue #1376 with Azure secrets
   (endpoint, key, storage). If the workflow run was already triggered, check the Actions tab for
   the run result. If it failed or wasn't triggered, manually dispatch:
   ```bash
   gh workflow run asset-request.yml
   ```
2. **Judge + approve** — once the worker produces a passing run under
   `generated/runs/alchemist-goggles/<run-id>/`, open `sprite-forge-lab`, invoke the
   `sprite-judge` skill, eyeball the candidate sheet, and approve the winner:
   ```bash
   npm run sprites:approve -- generated/runs/alchemist-goggles/<run-id> --variant <N>
   ```
3. **Check in** — `npm run sprites:checkin` creates an `asset-checkin` branch + tracking issue.
4. **Asset PR** — `npm run sprites:asset-pr` batches all open `asset-checkin` issues into one
   squash-merged art-only PR closing #1376.
5. **Wiring** — after the art merges: `resolveItemSprite('alchemist-goggles')` auto-resolves to
   the runtime key via the item catalog / manifest (same auto-resolve path as `iron-greaves`
   and `gearwork-locket`). No engine code changes expected. Verify with `npm run lab` or
   `npm run dev` that the icon renders in the equipment UI.

## Manifest identity contract

Placeholder established in commit `47ddc42e` (feat(sprites): add floor 2 equipment placeholders):

```json
"equipment/head/alchemist-goggles": {
  "briefId": "equipment/head/alchemist-goggles",
  "spriteName": "equipment/head/alchemist-goggles",
  "assetPath": "generated/equipment/head/alchemist-goggles-placeholder.png",
  "equipment": {
    "stableId": "head.alchemist-goggles",
    "runtimeKey": "equipment/head/alchemist-goggles",
    "category": "armor",
    "family": "headgear",
    "slot": "head",
    "productionWaveId": "floor2-equipment-ui-head"
  }
}
```

The approved asset must land at `generated/equipment/head/alchemist-goggles-var-N.png` and
update this manifest entry to replace `assetPath` with the real PNG and clear
`"sourceRun": "floor2-equipment-placeholder/v1"`.
