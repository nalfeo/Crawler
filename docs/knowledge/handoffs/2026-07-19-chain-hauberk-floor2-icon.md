---
systems_touched:
  - sprite-workflow
  - inventory
---

# Handoff: Chain Hauberk Floor 2 Equipment Icon (Issue #1372)

## Date

2026-07-19

## Persona

Graphics Designer

## Apples

Estimated: 🍎 x 2
Actual: 🍎 x 2
Verdict: 🎯 Exact

## Systems touched

- sprite-workflow (brief, placeholder, art plan)
- inventory (item catalog, equipment defs)

## What Was Done

Produced the full wiring scaffolding for the Floor 2 `chain-hauberk` torso-slot
equipment icon, closing issue #1372 (aggregate #1303, production wave
`floor2-equipment-ui-torso`). Pattern followed the `batfolk-hood` and
`runed-cuirass` precedents exactly.

### Sprite brief

`briefs/items/chain-hauberk.yaml` — authored a YAML brief for the item-type
sprite pipeline. Key design choices:

- **Subject:** chain-mail hauberk (long mail coat of interlocking steel rings),
  centered equipment icon, transparent background. Silhouette must read as
  "chain mail armor" at 64×64 — broad inverted-trapezoid shape with sleeve stubs.
- **Palette cue:** cool blue-grey steel with subtle highlights where rings catch
  light; dark recesses between ring rows give depth.
- **Variations:** four flavour variants covering classic riveted rings, blued
  steel, doubled shoulder rings with aventail, and finer-gauge lighter mail.
- `judge: { enabled: true }` and `minVariations: 4` for quality filtering.
- `sensors.edge.allowMainTouch: true` (body-length mail expected to reach frame).

### Item and equipment defs

- **`src/shared/items.ts`** — added `gear('chain-hauberk', ...)` as an `uncommon`
  wearable item. Flavor: "Thousands of interlocking rings, each one a quiet
  argument against dying today." Inserted between `iron-breastplate` and
  `runed-cuirass` in the chest-armor block.
- **`src/shared/equipmentDefs.ts`** — added equipment def for `chain-hauberk`,
  `slots: ['chest']`, `statBonuses: { armor: 3, constitution: 1 }`,
  `weightLb: 18`. Thematically: mid-tier chain mail between iron-breastplate
  (armor 4, 15 lb) and runed-cuirass (armor 6, magical). Inserted after
  `iron-breastplate` in `GEAR_EQUIPMENT_DEFS`.

### Placeholder

`npm run sprites:gen-placeholders` wrote a procedural placeholder PNG
(`public/assets/generated/chain-hauberk-placeholder.png`) and registered the
manifest entry so the EquipmentUI renders the procedural icon while real art
is pending.

### Art plan

Added `chain-hauberk` as an asset entry in
`plans/item-icons/equipment-gear.art.yaml` (the existing Floor 1/2 equipment
gear art plan), positioned after `runed-cuirass`. This satisfies the
`art-plan-catalog` test guard which requires every ITEM_CATALOG entry to appear
in exactly one committed art-plan file.

### Tests updated

- `tests/unit/items.test.ts` — snapshot count: 136 → 137
- `tests/ecs/equipment.test.ts` — `GEAR_ITEM_IDS` length: 17 → 18 (test
  description also updated from "17" to "18")

### Verify gate

`npm run verify:fast` — **all 1295 tests pass**.

## Sprite generation blocker

The actual PNG sprite generation via Azure OpenAI requires `AZURE_OPENAI_ENDPOINT`
and `AZURE_OPENAI_API_KEY`, which are not available in the Copilot coding-agent
CI environment. Generation is designed to run via the
`.github/workflows/asset-request.yml` workflow (triggered by an issue with the
`asset-request` label carrying the brief path).

**Art generation already completed (run `2026-07-18T01-54-11-af8cba88`)**

Issue #1372 received an "Asset-request pipeline complete" comment on 2026-07-18
for brief `chain-hauberk-v3` / run `2026-07-18T01-54-11-af8cba88`. The brief ran
successfully and variants are available for review. The next steps are to judge,
approve, and check in the existing run — **do NOT re-add the `asset-request`
label** (that would enqueue a redundant second run):

1. Judge the variants from the completed run:
   `npm run sprites:gallery` → sprite-judge skill against run `2026-07-18T01-54-11-af8cba88`
2. `npm run sprites:approve -- <runDir> --variant <N>` for the accepted variant
3. `npm run sprites:checkin` to push the art branch + open an `asset-checkin` issue
4. `npm run sprites:asset-pr` (asset-pr skill) to batch into a single art PR

Once art is merged, wiring is automatic: `resolveItemSprite('chain-hauberk')` in
`src/shared/item-sprites.ts` matches manifest entries whose `briefId` starts with
`chain-hauberk`, so the EquipmentUI will automatically use the approved variant —
no further code changes required.

## Observe before done

This change is a data/scaffold scaffolding session (new item/equipment defs,
placeholder PNG, sprite brief, art-plan entry). The observable artifact is the
item and equipment catalog:

- **Before:** `getItemById('chain-hauberk')` was undefined; no `EquipmentItemDef`
  with `id: 'chain-hauberk'` existed; `ITEM_CATALOG` had 136 entries.
- **After:** `ITEM_CATALOG` has 137 entries; `getItemById('chain-hauberk')` returns
  the uncommon gear item; `getEquipmentDefForItem('chain-hauberk')` returns
  `slots: ['chest'], statBonuses: { armor: 3, constitution: 1 }, weightLb: 18`;
  a placeholder PNG is registered in the sprite manifest.

These are verified deterministically by the unit tests (tests/unit/items.test.ts
and tests/ecs/equipment.test.ts). Visual rendering of the placeholder in the
EquipmentUI panel requires `npm run dev` with the item equipped — not run in this
session. The placeholder provides runtime correctness (no undefined key errors);
visual polish is deferred to the art-review step above.

## Unresolved issues

- Real art still needs to be judged, approved, and checked in from the completed
  run `2026-07-18T01-54-11-af8cba88` (see Pending section above).

## Branch State

- All tests passing: yes
- PR: open (feat(items): scaffold chain-hauberk Floor 2 torso equipment icon)
- Closes #1372 (aggregate #1303)
