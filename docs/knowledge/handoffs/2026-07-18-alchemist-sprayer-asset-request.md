# Handoff: alchemist-sprayer Asset Request (Issue #1467)

**Date:** 2026-07-18
**Session slug:** alchemist-sprayer-asset-request
**Apple estimate:** 1🍎 (art-only brief authoring) + 2🍎 (wiring PR, future)
**Issue:** nalfeo/Crawler#1467
**Branch:** `copilot/alchemist-sprayer-asset-request`

## Summary

Handled asset-request issue #1467 for the `alchemist-sprayer` Floor 2 weapon icon.
Authored a production-quality brief and added the asset to the weapons art-plan
backlog. The generation step requires Azure OpenAI credentials available only
via the `asset-request.yml` workflow (GitHub Secrets).

## Systems touched

- `briefs/weapons/alchemist-sprayer.yaml` — new weapon brief (Floor 2, vertical orientation)
- `plans/item-icons/weapons.art.yaml` — added `alchemist-sprayer` tracking entry

## Key decisions

### Brief design

- **Type:** `weapon` — inherits 64×64 size, kenney-roguelike palette, vertical orientation,
  `anchor: {x:32, y:56}`, `judge.enabled: true`, and 4×4 sheet defaults from
  `data/sprite-types/weapon.json`.
- **Floor 2 context:** `floor: 2` set so the generation model applies the "retro-futurist
  corporate decay" intensity context from `content-direction.ts`.
- **Silhouette spec:** cylindrical pressure canister body + flared brass nozzle crown at top +
  wrapped grip at bottom. Hazard stripe wraps the canister. Chemical staining on nozzle.
  The silhouette reads "spray weapon" unambiguously at 64×64.
- **No diagonal override:** vertical is correct for this weapon — the nozzle points up,
  grip is at the bottom. The default `sensors.weapon.orientation: vertical` applies.
- **Variations seeded:** 3 authored seeds (twin nozzle, pressure gauge, sponsor decal) +
  `minVariations: 8` so the text provider fills the rest.

### Runtime key constraint

The issue specifies runtime key `equipment/weapon/alchemist-sprayer`. In the pipeline
identity model, the generated sprite will be keyed as `alchemist-sprayer-var-N` in the
manifest. "equipment/weapon/" is descriptive category context, not the literal texture key.
The wiring PR must add `alchemist-sprayer` to `ITEM_CATALOG` in `src/shared/items.ts` with
the `Weapons` tag so that `resolveItemSprite` auto-resolves the icon by item id.

### Art plan entry

Added to `plans/item-icons/weapons.art.yaml` with `placeholderInUse: true`. The
art-plan-catalog guard skips catalog-absent items, so this entry is safe before the
wiring PR adds the catalog entry.

## Completion gate

### Done ✅

- Brief YAML authored and validated (`loadBrief` clean, no schema errors)
- Art plan updated (`art-plan-catalog` tests: 3/3 pass)
- Sprite unit tests: 76/76 pass

### Blocked — Azure credentials required 🔒

Generation, approval, checkin, asset-PR, and wiring all require Azure OpenAI (image
generation) and, for the approval step, Azure Blob Storage (run artifacts). These are
only available via GitHub Secrets in the `asset-request.yml` workflow.

## Next steps (run with Azure credentials)

```bash
# 1. Trigger generation via the asset-request workflow
gh workflow run asset-request.yml --repo nalfeo/Crawler

# 2. OR run directly with Azure credentials loaded
npm run sprites:run -- --brief briefs/weapons/alchemist-sprayer.yaml

# 3. Judge the variants (local-only, not in CI)
#    View generated/runs/alchemist-sprayer/<runId>/
#    Accept if combinedPassed = true AND VLM judge score >= 3

# 4. Approve the best variant
npm run sprites:approve -- generated/runs/alchemist-sprayer/<runId> --variant <N>

# 5. Check in
npm run sprites:checkin

# 6. Batch into asset PR
npm run sprites:asset-pr

# 7. Wire (separate code PR — 2🍎, needs full gates)
#    Add alchemist-sprayer to ITEM_CATALOG in src/shared/items.ts
#    Add equipment def in src/shared/equipmentDefs.ts (if needed for Floor 2)
#    Run: npm run sprites:generate-wiring -- --since main
#    Verify: npm run verify:fast

# 8. Observe in-game (npm run dev) and confirm icon renders
```

## Known pre-existing test failure (unrelated to this PR's scope)

Outside the sprite/art-plan changes in this PR,
`tests/unit/agent/epic-status.test.ts` has 1 pre-existing failing test:
`rejects merge facts that point at a non-commit git object`

This failure is caused by the shallow clone (depth=2) not containing the specific
git object `461b8a334a018ebbf6e81aa7b31f81c74e08aa6b` referenced in the test fixture.
It is pre-existing and unrelated to the brief/art-plan changes here.

## Files touched

| File                                                                    | What changed                                  |
| ----------------------------------------------------------------------- | --------------------------------------------- |
| `briefs/weapons/alchemist-sprayer.yaml`                                 | New production brief for Floor 2 spray weapon |
| `plans/item-icons/weapons.art.yaml`                                     | Added `alchemist-sprayer` tracking entry      |
| `docs/knowledge/handoffs/2026-07-18-alchemist-sprayer-asset-request.md` | This handoff                                  |
