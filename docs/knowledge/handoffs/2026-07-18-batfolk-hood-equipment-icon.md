---
systems_touched:
  - sprite-workflow
  - inventory
---

# Handoff: Batfolk Hood Equipment Icon (Issue #1370)

## Date

2026-07-18

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

Produced the full wiring scaffolding for the Floor 2 `batfolk-hood` head-slot
equipment icon, closing issue #1370 (aggregate #1303, production wave
`floor2-equipment-ui-head`).

### Sprite brief

`briefs/items/batfolk-hood.yaml` — authored a minimal YAML brief for the
item-type sprite pipeline. Key design choices:

- **Subject:** bat-eared membrane hood, centered equipment icon, transparent
  background. Silhouette must read as "bat-eared hood" at 16 px.
- **Palette cue:** deep charcoal / midnight-purple with tarnished metal rivets,
  consistent with Countess Vesper batfolk palette (`batfolk-boss.yaml`).
- **Variations:** three flavour variants (charcoal+copper, midnight-blue+bone,
  smoke-grey+violet) to give the pipeline candidates to choose from.
- `judge: { enabled: true, maxVariants: 8 }` for quality filtering.

### Item and equipment defs

- **`src/shared/items.ts`** — added `gear('batfolk-hood', ...)` as an `uncommon`
  wearable item. Flavor: "Cured membrane hide with twin bat-ear protrusions.
  Floor 2 souvenir."
- **`src/shared/equipmentDefs.ts`** — added equipment def for `batfolk-hood`,
  `slots: ['head']`, `statBonuses: { armor: 1, dexterity: 2, dodgeChance: 0.04 }`.
  Thematically: lightweight batfolk evasion gear.

### Placeholder

`npm run sprites:gen-placeholders` wrote a procedural 16×16 placeholder PNG
(`public/assets/generated/batfolk-hood-placeholder.png`) and registered the
manifest entry so the EquipmentUI renders the procedural icon while real art
is pending.

### Art plan

Added `batfolk-hood` as an asset entry in
`plans/item-icons/equipment-gear.art.yaml` (the existing Floor 1/2 equipment
gear art plan). This satisfies the `art-plan-catalog` test guard which requires
every ITEM_CATALOG entry to appear in exactly one committed art-plan file.

### Tests updated

- `tests/unit/items.test.ts` — snapshot count: 126 → 127
- `tests/ecs/equipment.test.ts` — `GEAR_ITEM_IDS` length: 15 → 16
- `tests/unit/sprites/art-plan-catalog.test.ts` — no change needed; coverage
  now picks up `batfolk-hood` from the plan file automatically.

### Verify gate

`npm run verify:fast` — **all 1260 tests pass**.

## Sprite generation blocker

The actual PNG sprite generation via Azure OpenAI requires `AZURE_OPENAI_ENDPOINT`
and `AZURE_OPENAI_API_KEY`, which are not available in the Copilot coding-agent
CI environment. Generation is designed to run via the
`.github/workflows/asset-request.yml` workflow (triggered by an issue with the
`asset-request` label carrying the brief path).

**To complete art generation:**

1. The merged PR puts the brief at `briefs/items/batfolk-hood.yaml`.
2. Trigger `npm run sprites:run -- --brief briefs/items/batfolk-hood.yaml` on a
   machine with Azure credentials (or via the `asset-request.yml` workflow
   dispatch).
3. Judge the variants with `npm run sprites:gallery` / sprite-judge skill.
4. `npm run sprites:approve -- <runDir> --variant <N>`
5. `npm run sprites:checkin` to push the art branch + open an `asset-checkin`
   issue.
6. `npm run sprites:asset-pr` (asset-pr skill) to batch into a single art PR.

Once art is merged, wiring is automatic: `resolveItemSprite('batfolk-hood')` in
`src/shared/item-sprites.ts` matches manifest entries whose `briefId` starts with
`batfolk-hood`, so the EquipmentUI will automatically use the approved variant —
no further code changes required.

## Observe before done

- **Before:** no `batfolk-hood` item existed; EquipmentUI head slot for
  `batfolk-hood` was undefined.
- **After:** `batfolk-hood` appears in `ITEM_CATALOG`, has a valid `EquipmentItemDef`
  with `slots: ['head']`, and the procedural placeholder PNG renders in the
  EquipmentUI head slot. When real art is approved and merged, `resolveItemSprite`
  auto-picks the best non-placeholder variant.

Confirmed via `npm run verify:fast` (1260/1260 tests pass). Visual observation
of the placeholder in-game requires `npm run dev` with the item added to the
player's bag — not run in this session (art generation blocked; placeholder
provides functional correctness).

## Unresolved issues

- Azure sprite generation not triggered (environment constraint — see above).
- Issue #1370 plan comment not posted (GitHub API not accessible in this env).

## Branch State

- Branch: `copilot/create-batfolk-hood-icon`
- All tests passing: yes (1260/1260)
- PR: open (this branch → main), closes #1370
