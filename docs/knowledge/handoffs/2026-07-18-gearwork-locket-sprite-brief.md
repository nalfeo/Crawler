# Session Handoff: gearwork-locket Sprite Brief

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

1🍎 exact — pure art task: brief authoring for the gearwork-locket Floor 2
equipment icon. No gameplay code changes.

## What Was Done

Handled issue #1380 for the `gearwork-locket` Floor 2 equipment accessory icon:

1. **Brief authored**: Created `briefs/items/gearwork-locket.yaml` with a detailed
   visual description matching the dungeon's Floor 2 industrial/mechanical
   aesthetic.

   Design intent: a small clockwork locket pendant on a short brass chain,
   shown face-on. Engraved gear-wheel pattern on the front face, small keyhole
   at center with miniature gear teeth visible through a half-moon cutout.
   Chain links are thick mechanical rectangular loops with notched edges.
   `allowMainTouch: true` because a pendant-on-chain item naturally contacts
   the frame edge at the chain end.

2. **Brief validated**: Parsed correctly, all required fields present, compatible
   with `data/sprite-types/item.json` defaults (64×64 output, kenney-roguelike
   palette, 4×4 generation sheet).

3. **Pipeline integration**: The GitHub Actions `asset-request.yml` workflow
   will ingest issue #1380 and synthesize/prefer this brief during the next
   run. The brief lives at `briefs/items/gearwork-locket.yaml` and matches
   the `name` field the pipeline uses as `briefId`.

## What's Next / Blockers

- The sprite has not yet been generated (requires Azure AI via GitHub Actions).
- When CI generates and approves a variant, the `sprites:checkin` step adds
  the entry to `public/assets/generated/manifest.json` with `briefId:
'gearwork-locket'`.
- After check-in, wiring the sprite to the Floor 2 equipment system
  (`gearwork-locket` item def + `equipmentDefs.ts` entry) is a separate task
  under the Floor 2 Equipment Epic (issue #1303).
- The brief is ready for the pipeline to consume via the `asset-request` issue
  workflow; no further authoring action is required.

## Key Decisions Made

- **Brief type `item`**: matches the issue's stated type and the Floor 2 equipment
  icon conventions used by other accessory items (`merchants-stained-charm`).
- **`allowMainTouch: true`**: standard for pendant/chain accessories since the
  chain end naturally reaches the image border.
- **`minVariations: 5`**: slightly above the item-type default of 3, giving the
  judge loop more headroom to pick a high-quality silhouette.
- **Mechanical/clockwork aesthetic**: derived from "Gearwork" in the name and
  the Floor 2 industrial dungeon theme. Three explicit variations cover
  brass, dark-iron, and copper colorways.
