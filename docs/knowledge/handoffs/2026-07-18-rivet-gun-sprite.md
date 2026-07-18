---
date: 2026-07-18
slug: rivet-gun-sprite
issue: '1336'
pr: null
systems: sprite-pipeline, sprite-workflow
apples: '1-2 (art) + 2 (wiring code PR, future)'
status: brief-authored-azure-blocked
---

# Handoff: rivet-gun sprite (issue #1336)

## Summary

Authored production-ready brief `briefs/weapons/rivet-gun.yaml` for the Floor 2
rivet-gun weapon icon (runtime key `equipment/weapon/rivet-gun`, stable ID
`weapon.rivet-gun`, production wave `floor2-equipment-weapon-firearm`).

Sprite generation is **blocked** by missing Azure OpenAI credentials in the
coding agent environment. Per the Azure-required sidecar policy (AGENTS.md §5),
we report this blocker rather than silently falling back.

## What was done

| Step                                  | Status          | Notes                                                                                       |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| Plan comment on #1336                 | ❌ API blocked  | GitHub GraphQL/REST inaccessible in coding agent env; CRAWLER_CI_PAT returns 403 on GH CLI  |
| Brief `briefs/weapons/rivet-gun.yaml` | ✅ Done         | Authored, YAML parsed, brief schema validated, fast verify passes                           |
| Brief schema validation               | ✅ Pass         | `npm run test:sprites` (1260 tests), `npm run verify:fast` both green                       |
| Azure sprite generation               | ❌ Blocked      | `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` not injected into coding agent environment |
| Judge / approve / checkin             | ⏸ Pending Azure | Can proceed once generation runs                                                            |
| Asset PR                              | ⏸ Pending       | `npm run sprites:asset-pr` after check-in                                                   |
| Wiring analysis                       | ✅ Done         | See § Wiring below                                                                          |
| Wiring code PR                        | ⏸ Future        | After art merges; see §Wiring                                                               |

## Brief details

```yaml
type: weapon
name: rivet-gun
floor: 2
description: |
  A heavy industrial rivet gun repurposed as a Floor 2 dungeon weapon, held
  vertically — barrel/muzzle pointing straight up, chunky pistol-grip and
  trigger assembly at the bottom. The body is a thick metal cylinder with
  a squared-off barrel tip, a pressure-chamber bulge midway up, and a
  stubby air-hose nozzle jutting from one side. Visible hexagonal rivet
  heads embedded in the frame. Worn gunmetal-grey and rust-orange metal
  with chipped paint exposing darker steel underneath; a single orange
  safety-band painted around the barrel, now scuffed. Interior shading in
  3–4 stops of dark grey: deep cavity shadow at the muzzle opening, mid
  steel tone, and a highlight edge along one side. No glow, no electricity,
  no blood. Silhouette must read unambiguously as a hand-held pneumatic gun,
  not a rocket launcher or a flashlight.
variations:
  - reinforced barrel with bolted-on iron ring clamps
  - copper pressure-relief valve on the side with a worn gauge dial
minVariations: 6
```

Inherits from `data/sprite-types/weapon.json`:

- `size: { width: 64, height: 64 }`
- `anchor: { x: 32, y: 56 }` (grip at bottom, no override needed)
- `sensors.weapon: { orientation: vertical, diagonalToleranceDeg: 5 }`
- `judge: { enabled: true, maxVariants: 16 }` (VLM judge enabled)
- 4×4 sheet, 16 variants, 1024 native canvas

## Azure credential blocker

The coding agent environment deliberately does NOT receive `AZURE_OPENAI_ENDPOINT`
or `AZURE_OPENAI_API_KEY`. These are scoped to the `asset-request.yml` GitHub
Actions workflow (drain step) per the security model documented in that file:

> Secrets stay scoped to THIS workflow (not `copilot-setup-steps.yml`) so
> the coding-agent runner env can't exfiltrate them either.

### To unblock generation

**Option A (recommended):** Trigger `asset-request.yml` workflow dispatch for
issue #1336. The workflow has Azure credentials injected and will:

1. Ingest the issue into the Azure queue
2. Run the sprite worker → generate → auto-approve → check-in
3. Create an `asset-checkin` issue and `assets/<slug>` branch
4. The `asset-pr` skill can then batch it into a PR

```bash
gh workflow run asset-request.yml --repo nalfeo/Crawler
```

**Option B (manual):** Provide credentials in `.env.local`:

```bash
# In a local dev environment with Azure access:
npm run setup:azure:env   # fast path, writes .env.local
SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop \
  npm run sprites:run -- --brief briefs/weapons/rivet-gun.yaml
```

Then judge + approve + checkin + asset-pr as normal.

## Wiring analysis (for when art arrives)

Per ADR 0051 (`item-sprites.ts`), item sprites **auto-resolve** when
`manifest.briefId === item.id`. The brief name is `rivet-gun`, which must
match the item's `id` field in `items.ts`.

**No changes to `generated-assets.ts` or `entity-sprite-mappings.json`** are
needed for the sprite lookup — that's enemy-only wiring.

The rivet-gun is a **new item** not yet in the codebase. When the gameplay content
work adds it, the following files need updating:

| File                          | Change                                              |
| ----------------------------- | --------------------------------------------------- |
| `src/shared/items.ts`         | Add `wpn('rivet-gun', 'Rivet Gun', '<flavour>', R)` |
| `src/shared/weaponDefs.ts`    | Add ranged weapon def (id: 'rivet-gun')             |
| `src/shared/equipmentDefs.ts` | Add `WeaponEquipmentDef` linking item → weapon      |
| `src/game/floorScenario.ts`   | Add to Floor 2 spawn weights                        |

The manifest entry (from `npm run sprites:approve`) will have `briefId: 'rivet-gun'`
and `spriteName: 'rivet-gun-var-N'`. The `resolveItemSprite` function picks this
up automatically for any item with `id === 'rivet-gun'`.

### Before / after observation

Before: no `rivet-gun` entries in manifest → `resolveItemSprite('rivet-gun', ...)`
returns the placeholder entry (or null if none).

After: manifest has `rivet-gun-var-N` → `resolveItemSprite` returns real art,
rendered in the inventory HUD at 64×64 with correct anchor (32, 56 grip).

Observation can be confirmed in `npm run lab` → inventory lab or HUD overlap lab.

## Systems touched

`sprite-pipeline, sprite-workflow`

## Apple estimate

- Art phase: **1–2 🍎** (review-ledger-exempt, art-only fast lane)
- Wiring code PR: **2 🍎** (full gates, fast verify required)
