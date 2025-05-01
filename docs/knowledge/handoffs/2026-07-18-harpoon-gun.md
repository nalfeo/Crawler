# Session Handoff: harpoon-gun Floor 2 Equipment Weapon Icon

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, item-catalog, art-plan-tracker

## Apples

- Art wave (brief + wiring): **1 🍎** — pure art task, review-ledger exempt
- Wiring (item definition + placeholder): **1 🍎** — small additive code change

## What Was Done

Handled issue #1358 for the `harpoon-gun` Floor 2 equipment weapon icon.

### Changes made

1. **Brief created** (`briefs/weapons/harpoon-gun.yaml`):
   - Vertical orientation (default weapon type), grip at bottom, harpoon tip at top
   - Industrial firearm aesthetic: chunky welded steel, rust-streaked seams, tethered chain
   - 3 variations + `minVariations: 6` for diversity
   - Inherits all weapon defaults (64×64, kenney-roguelike palette, 4×4 sheet, VLM judge enabled)

2. **Item catalog wiring** (`src/shared/items.ts`):
   - Added `wpn('harpoon-gun', 'Harpoon Gun', 'Fire a tethered bolt and reel them in.', R)`
   - Placed after `anchor-mace` (other Floor 2 Rare weapon) for logical grouping

3. **Placeholder PNG and manifest entry** (`public/assets/generated/`):
   - Generated via `npm run sprites:gen-placeholders`
   - `harpoon-gun-placeholder.png` (16×16 procedural icon)
   - Manifest entry: `harpoon-gun-placeholder` with `sourceRun: placeholder`
   - Additional 11 other items also got their missing placeholders filled (side effect of gen-placeholders run)

4. **Art-plan tracker** (`plans/item-icons/weapons.art.yaml`):
   - Added `harpoon-gun` entry required by `art-plan-catalog.test.ts` coverage check

5. **Sprite catalog sync** (`src/shared/data/sprite-catalog.json`):
   - Ran `npm run sprites:sync-catalog` to pick up new manifest entries
   - Added `generated:faerie-boss-var-0` that was in manifest but missing from catalog

6. **Test snapshots** (`tests/unit/items.test.ts`):
   - Updated catalog size: 126 → 127
   - Updated Weapons tag count: 23 → 24

## What Did NOT Happen (CI Constraint)

Azure OpenAI credentials are not available in this CI environment (CI=true, no `.env.local`).
The following steps from the pipeline could NOT be run locally:

- **Generation** (`npm run sprites:run --brief briefs/weapons/harpoon-gun.yaml`)
- **Judge pass** (VLM judge is blocked in CI by Constitutional §3)
- **Approve** (no run artifacts to approve)
- **Checkin** (`checkin.ts` is hard-blocked in CI)
- **Asset PR** (`asset-pr.ts` is hard-blocked in CI)

### How to complete generation

1. Add the `asset-request` label to issue #1358 in the GitHub repo
2. The `asset-request.yml` workflow will trigger automatically
3. The workflow synthesizes a brief and generates sprites, posting results to the issue
4. Review the sprites in the issue comments (or via `npm run sprites:gallery`)
5. Approve the best variant: `npm run sprites:approve -- <runDir> --variant <N>`
6. Check in: `npm run sprites:checkin`
7. Batch art PR: `npm run sprites:asset-pr`

Alternatively, on a developer workstation with `.env.local`:

```bash
npm run sprites:run -- --brief briefs/weapons/harpoon-gun.yaml
# Review generated/runs/harpoon-gun/<runId>/
npm run sprites:approve -- generated/runs/harpoon-gun/<runId> --variant <N>
npm run sprites:checkin
npm run sprites:asset-pr
```

## Observe Before Done

The placeholder sprite (`harpoon-gun-placeholder.png`) is a 16×16 procedural icon, visible in:

- Inventory UI when a `harpoon-gun` item is in the bag
- Equipment slot when equipped

Real approved art (once generated) will auto-resolve via `resolveItemSprite('harpoon-gun')` —
no additional wiring code needed, per ADR 0051 (item sprites resolve by item id).

## Key Decisions

1. **Vertical orientation** — harpoon guns are handheld firearms held pointing forward (upward in
   the vertical convention). No sensor override needed; default weapon type defaults to vertical.

2. **Rare rarity** — consistent with other Floor 2 specialized ranged weapons (`plasma-pistol: R`,
   `chain-whip: R`, `anchor-mace: R`). The harpoon gun is a dungeon-found ranged utility weapon.

3. **Brief in weapons/ not draft/** — created the proper canonical brief under `briefs/weapons/`
   rather than `briefs/draft/` (the asset-request workflow uses draft/ for synthesized briefs).
   The `briefs/weapons/harpoon-gun.yaml` is the authoritative brief for future re-generations.

4. **Item wiring only, no weapon-def** — did not add `harpoon-gun` to `data/weapons.json` or
   `equipmentDefs.ts`. Those are game-mechanics decisions (damage, range, weapon type, ECS
   equipment slot). Icon wiring only requires the item catalog entry + manifest placeholder.
   Game mechanics can be wired in a follow-up PR by the Systems Engineer persona.
