# G2-A: Add deterministic equipment placeholders and art-key manifest

**Date**: 2026-07-18  
**Session slug**: g2-a-floor2-equipment-placeholders  
**Apple estimate**: 3🍎 (actual: 3🍎, exact)  
**PR**: copilot/g2-a-add-deterministic-placeholders  
**Parent branch**: nalfeo-floor-2-equipment-contracts @ 4c11335a281842f82d206a4c42b23a28e2f40e91  
**Issue**: nalfeo/Crawler#1291

## Systems touched

sprite-pipeline, shared-data

## Summary

Implemented the stable 70-key Floor 2 equipment art-key manifest, deterministic procedural placeholder generation, and production-wave art plan YAMLs for the Floor 2 equipment epic (G2-A slice). This is a pure sprite-pipeline slice with no gameplay stats, equipment generator, inventory, or runtime-key changes.

## Key deliverables

1. **`src/shared/data/floor2-equipment-art-keys.json`** — stable 70-key manifest JSON:
   - `weaponFamilies`: 10 families (heavy-blade, blunt, polearm, bow, thrown, light-blade, wand, alchemical, utility, mechanical), 5 weapons each
   - `entries`: 70 objects with `artKey`, `type`, `family`/`slot`, `label`, `runtimeKey`, `description`
   - Art key format: `type.base-name` (dot notation) — immutable per PLAN.md contract

2. **`src/shared/floor2-equipment-art-keys.ts`** — typed TypeScript wrapper:
   - Exports `FLOOR2_EQUIPMENT_ART_ENTRIES`, `FLOOR2_WEAPON_FAMILIES`, `FLOOR2_EQUIPMENT_ART_KEY_SET`, `FLOOR2_WEAPON_ART_ENTRIES`, `FLOOR2_ARMOR_ART_ENTRIES`
   - Helper functions `floor2EquipmentPlaceholderKey(artKey)` and `floor2EquipmentPlaceholderPng(artKey)` convert dot-notation art keys to kebab-case IDs for pipeline identity (dots → hyphens)

3. **`scripts/sprites/gen-placeholders.ts`** — extended with Floor 2 loop:
   - Generates 70 procedural placeholder PNGs using `artKey` as the render seed
   - Pipeline identity uses kebab-case `briefId = artKey.replace(/\./g, '-')` so `normalizeConcept()` correctly links placeholders to real approved art from production-wave plans
   - PNGs in `public/assets/generated/`, manifest entries under `weapon-iron-cleaver-placeholder` etc.

4. **`plans/floor2-equipment/floor2-weapons.art.yaml`** — 50 weapon entries (10 families):
   - IDs: `weapon-<base-name>` (e.g. `weapon-iron-cleaver`)
   - Types: all `weapon`
   - No `integration` fields (no runtime wiring targets yet; added in a later slice)

5. **`plans/floor2-equipment/floor2-armor.art.yaml`** — 20 non-weapon entries:
   - IDs: `<slot>-<base-name>` (e.g. `head-iron-visor`, `torso-leather-vest`)
   - Types: all `item`
   - Slot-prefixed IDs avoid ITEM_CATALOG collision (`iron-visor` and `iron-greaves` are Floor 1 items; Floor 2 uses `head-iron-visor`, `feet-iron-greaves`)
   - No `integration` fields

6. **`tests/unit/sprites/floor2-equipment-art-manifest.test.ts`** — 30 tests (all passing):
   - Entry count and structure (9 tests)
   - Weapon family coverage (6 tests)
   - Slot coverage (5 tests)
   - Generated manifest placeholder coverage (5 tests)
   - YAML↔manifest cross-sync guard (3 tests — validates every JSON entry appears in exactly one YAML and every YAML ID maps back to the JSON manifest)

## Critical identity model decision

The plan review (gpt-5.4) identified a blocking issue: the initial implementation used dotted `artKey` as the `briefId` in placeholder manifest entries (e.g. `briefId: "weapon.iron-cleaver"`). The `normalizeConcept()` function in `placeholder-audit.ts` takes the last segment after the last dot, so `normalizeConcept("weapon.iron-cleaver")` → `iron-cleaver`, whereas the art-plan brief ID `weapon-iron-cleaver` normalizes to `weapon-iron-cleaver`. These don't match — approved art would not link to the placeholder in the audit.

**Fix**: Use `briefId = artKey.replace(/\./g, '-')` throughout (manifest entries, PNG filenames, manifest keys):

- `weapon.iron-cleaver` → `briefId: weapon-iron-cleaver` → `normalizeConcept` → `weapon-iron-cleaver`
- Art plan ID `weapon-iron-cleaver` → brief name `weapon-iron-cleaver` → `normalizeConcept` → `weapon-iron-cleaver`
- They match ✓

The dotted `artKey` is preserved as the immutable concept name in `floor2-equipment-art-keys.json` and as the procedural render seed; it does NOT appear in any pipeline identity field.

## Review harness

- **Apple tier**: 3🍎 → plan review + code review required
- **Plan review**: gpt-5.4 — verdict `minor` (blocking briefId fix + 3 non-blocking improvements, no re-architecture)
- **Code review round 1**: claude-sonnet-4.6 — clean
- **Code review round 2**: claude-sonnet-4.6 — (running at handoff; see review ledger)
- **Ledger**: `docs/knowledge/review-ledgers/2026-07-18-g2-a-floor2-equipment-placeholders.review-ledger.json`
- **Apple record**: `docs/knowledge/metrics/apples/2026-07-18-g2-a-floor2-equipment-placeholders.json`

## What's NOT in this slice

Per the G2-A scope exclusions:

- No gameplay stats, equipment defs, item catalog entries
- No equipment generator, inventory, merchant, reward, AI changes
- No final production sprite approval
- No runtime-key renaming or sprite-registry wiring (will be a later slice)
- The `integration` field is intentionally absent from YAML plan entries; it will be added when runtime sprite-registry entries exist for Floor 2 equipment

## Next steps (G2-B and later)

1. **G2-B**: Equipment defs and item catalog for Floor 2 gear (gameplay stats, ItemCatalog entries)
2. **Art waves**: Run `npm run sprites:plan-drafts` on the two art plans to draft briefs, then `sprites:run` + `sprites:approve` to generate real art
3. **Wiring**: Add `integration: { kind: sprite-registry, id: <artKey.replace('.','/') ... }` to YAML entries once sprite-registry entries exist
4. **Placeholder audit**: Once real art is approved, `npm run sprites:placeholder-audit` will link the approved `weapon-iron-cleaver-var-0` briefId to the `weapon-iron-cleaver-placeholder` entry (they normalize to the same concept)
