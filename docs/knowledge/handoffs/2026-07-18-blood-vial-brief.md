# Handoff: blood-vial sprite brief

## Summary

Created the sprite brief for the `blood-vial` Floor 2 equipment accessory icon.
This brief feeds the Azure sidecar generation pipeline when the asset-request
workflow processes issue #1388.

## Systems touched

sprites, items

## Files touched

- `briefs/items/blood-vial.yaml` — new sprite brief for the blood-vial accessory

## What was done

- Researched the Floor 2 equipment epic plan confirming `accessory.blood-vial`
  (stable ID) with runtime key `equipment/accessory/blood-vial` is a planned item
- Created a sprite brief describing a slender glass vial of blood on a cord,
  styled as a worn dungeon accessory, matching the Crawler design language
- Brief follows the `minimalBriefSchema` pattern (type + name + description +
  variations + sensors), using `item` type defaults from `data/sprite-types/item.json`
- Set `sensors.edge.allowMainTouch: true` (consistent with other wearable
  accessories like `merchants-stained-charm`) to allow the cord to touch the
  frame edges
- 3 authored variations plus `minVariations: 5` so the pipeline has enough
  headroom for quality selection

## Context

Issue #1388 (canonical) is the open asset request for blood-vial. Issue #1495
was closed as a duplicate. The GitHub Actions `asset-request.yml` workflow will
pick up the brief when it processes the open issue or on `workflow_dispatch`.
The actual sprite PNG generation requires Azure OpenAI credentials (not
available locally); the workflow handles this.

## Verification

- `npm run verify:fast` — 1260 tests passed, fast verification passed
- Brief YAML parses cleanly and passes manual schema validation

## Unresolved issues

None. The brief is ready for Azure generation. Once the sprite is generated and
approved, a follow-up session should wire the manifest entry to the
`equipment/accessory/blood-vial` runtime key.

## Recommended next steps

1. Re-trigger the `asset-request.yml` workflow for issue #1388 (the canonical
   blood-vial request) so the Azure sidecar generates the sprite from this brief
2. Judge and approve the generated variant
3. Check in the approved art via `npm run sprites:checkin`
4. Create the art PR via `npm run sprites:asset-pr`
5. Wire the sprite to the runtime key in the engine sprite registry
