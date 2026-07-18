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

Recovered the branch's Floor 2 equipment placeholder review blockers by aligning
the placeholder manifest `briefId`s with the real kebab-case pipeline contract,
removing false integration metadata from the two Floor 2 art backlog plans, and
adding generator regression coverage that exercises the real `run()` codepath.

## Key deliverables

1. **`src/shared/floor2-equipment-art-keys.ts`**
   - Documents the three-way contract split:
     - dotted immutable `artKey` for the concept
     - kebab-case pipeline `briefId`
     - slash-separated `runtimeKey`
   - Adds `floor2EquipmentPipelineBriefId(artKey)` as the canonical mapping helper

2. **`scripts/sprites/gen-placeholders.ts`**
   - Uses the canonical kebab-case pipeline `briefId` for Floor 2 placeholder
     manifest entries and real-approval detection
   - Preserves the dotted placeholder manifest keys and PNG filenames
     (`weapon.iron-cleaver-placeholder`)

3. **`public/assets/generated/manifest.json`**
   - Rewrites the 70 checked-in Floor 2 placeholder entries so `briefId` and
     `spriteName` are kebab-case pipeline ids, while the outer manifest keys and
     asset paths remain dotted placeholder identities

4. **`plans/floor2-equipment/floor2-weapons.art.yaml`** and
   **`plans/floor2-equipment/floor2-armor.art.yaml`**
   - Remove invalid `integration` blocks that claimed nonexistent runtime
     consumers
   - Clarify in the plan summaries that the runtime-key contract lives in
     `src/shared/floor2-equipment-art-keys.ts` and real wiring is a later slice

5. **`tests/unit/sprites/floor2-equipment-art-manifest.test.ts`** and
   **`tests/unit/sprites/gen-placeholders.test.ts`**
   - Add real `run()` regression coverage for initial generation, rerun without
     force, force dry-run no-write behavior, and “real approval already exists”
     skipping
   - Assert the committed Floor 2 plans cover the canonical brief-id set and
     intentionally omit integration targets until runtime wiring exists

## Critical identity model decision

The plan review (gpt-5.4) identified a blocking issue: the placeholder manifest
entries used dotted `artKey` values as pipeline `briefId`s (for example,
`briefId: "weapon.iron-cleaver"`). Real approved art cannot use dots in the
brief name, and `placeholder-audit.ts` normalizes dotted and kebab-case names
into different concept buckets, so approved art would never link back to the
placeholder entry.

**Fix**: use a canonical pipeline `briefId = weapon-iron-cleaver` inside the
manifest entries, but keep the stable dotted placeholder key/file identity:

- `weapon.iron-cleaver` → `briefId: weapon-iron-cleaver` → `normalizeConcept` → `weapon-iron-cleaver`
- Art plan ID `weapon-iron-cleaver` → brief name `weapon-iron-cleaver` → `normalizeConcept` → `weapon-iron-cleaver`
- They match ✓

The dotted `artKey` is preserved as the immutable concept name and as the
placeholder manifest key / PNG filename; only the pipeline `briefId` becomes
kebab-case.

## Review harness

- **Apple tier**: 3🍎 → plan review + code review required
- **Plan review**: gpt-5.4 — verdict `minor` (blocking briefId fix + 3 non-blocking improvements, no re-architecture)
- **Code review round 1**: claude-sonnet-4.6 — surfaced the committed dotted-briefId bug; resolved in the follow-up repair
- **Code review round 2**: claude-sonnet-4.6 — clean on the final working-tree diff
- **Ledger**: `docs/knowledge/review-ledgers/2026-07-18-g2-a-floor2-equipment-placeholders.review-ledger.json`
- **Apple record**: `docs/knowledge/metrics/apples/2026-07-18-g2-a-floor2-equipment-placeholders.json`

## What's NOT in this slice

Per the G2-A scope exclusions:

- No gameplay stats, equipment defs, item catalog entries
- No equipment generator, inventory, merchant, reward, AI changes
- No final production sprite approval
- No runtime-key renaming or sprite-registry wiring (still a later slice)
- The `integration` field is intentionally absent from the YAML plan entries;
  the previous values were false metadata because no runtime consumer exists yet

## Next steps (G2-B and later)

1. Add the real runtime consumer / wiring for these Floor 2 generated equipment
   assets before reintroducing any `integration` metadata in the plan YAMLs.
2. Run `npm run sprites:plan-drafts` on the two art plans, then
   `sprites:run` + `sprites:approve` to generate and approve real art.
3. After the first real approvals land, run
   `npm run sprites:placeholder-audit` to confirm the kebab-case approved
   `briefId`s now collapse onto the matching dotted placeholder entries.
