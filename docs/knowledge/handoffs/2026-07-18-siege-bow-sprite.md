# Handoff: siege-bow weapon sprite (2026-07-18)

## Status

**Brief authored and validated. Azure generation pending via `asset-request` workflow.**

## Systems touched

| System                                | Change                                     |
| ------------------------------------- | ------------------------------------------ |
| `briefs/weapons/siege-bow.yaml`       | New authored brief                         |
| `public/assets/generated/`            | Will contain approved PNG after generation |
| `src/shared/data/sprite-catalog.json` | Will be updated by `sprites:approve`       |

## Apple estimate: 1 🍎 — art-only, review-ledger-exempt

## What was done this session

- ✅ Posted plan comment on issue #1340
- ✅ Authored `briefs/weapons/siege-bow.yaml` for the `siege-bow` Floor 2 weapon icon
- ✅ Brief validated against Zod schema via `npm run sprites:run -- --brief briefs/weapons/siege-bow.yaml` (schema-valid; fails only on missing `AZURE_OPENAI_ENDPOINT`)
- ✅ PR #1411 updated with brief on branch `copilot/create-siege-bow-icon`
- ✅ Rebased branch on main; PR #1411 is open, ready for review (not draft)
- ✅ Code review (parallel_validation): no issues on YAML brief + handoff
- ✅ CodeQL scan: trivially skipped (no source code changes)

## Brief specification

| Field              | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| Runtime key        | `equipment/weapon/siege-bow`                                   |
| Brief name         | `siege-bow`                                                    |
| Type               | `weapon`                                                       |
| Floor              | 2                                                              |
| Size               | 64×64                                                          |
| Palette            | `kenney-roguelike`                                             |
| Sheet layout       | 4×4 grid, 16 variants                                          |
| Orientation        | `vertical` (default weapon — grip at bottom, limb tips at top) |
| `centerToleranceX` | 5px (relaxed vs default; oversized limbs are inherently wider) |
| `judge.enabled`    | `true`                                                         |
| Anchor             | Derived from grip band (`bandRows: 4`)                         |

### Brief subject

> A massive, heavy-duty siege bow held vertically, limb tips at the top, grip straight down. Oversized recurved limbs — much thicker and wider than a standard bow — reinforced with iron bands. Worn dark wood, iron/steel reinforcement bands, steel-grey metal fittings. No arrows, no glow, no enchantment. Silhouette must read as siege-scale — not a sword or crossbow.

### Variations seeded

1. Extra-wide recurved limbs with visible wood lamination layers
2. Iron-reinforced limbs with bolted metal plates along the length

## Blocker: Azure credentials unavailable in CI

`sprites:run` requires `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY`. The cloud runner environment blocks direct access to api.github.com and has no Azure OpenAI credentials.

`checkin.ts` also refuses when `CI=true` (Constitutional §3, unless `SPRITES_ALLOW_CI_PIPELINE=true`).

## How to complete the pipeline

### Recommended: Trigger via `asset-request.yml` workflow

The `asset-request.yml` workflow runs `sprites:ingest-once` + `sprites:worker` with full Azure secrets injected, and sets `SPRITES_ALLOW_CI_PIPELINE=true` so the VLM judge runs.

1. Add the `asset-request` label to issue **#1340** (triggers `labeled` event → workflow dispatch)
2. The workflow will synthesize a brief (or use `briefs/weapons/siege-bow.yaml`), generate 16 variants, judge, and approve the best variant
3. After the workflow posts ✅ on issue #1340, run `npm run sprites:checkin` from a local session with Azure Storage credentials
4. Run `npm run sprites:asset-pr` to batch the art into a game PR
5. Close issue #1340 in the art PR

### Alternative: Run locally

```bash
pwsh scripts/setup-azure-env.ps1 -IncludeStorage
npm run sprites:run -- --brief briefs/weapons/siege-bow.yaml
# Review output in generated/runs/siege-bow/<run-id>/
npm run sprites:approve -- generated/runs/siege-bow/<run-id> --variant <N>
npm run sprites:checkin
npm run sprites:asset-pr
```

## Identity resolution

The brief name `siege-bow` matches the item slug convention. Once the art is checked in:

- Manifest key: `siege-bow-var-N`
- Item resolution: `itemSpriteConcepts('siege-bow')` → `['siege-bow']` → matches `siege-bow-var-N`
- Auto-resolves via `resolveItemSprite` without any additional wiring code

## Wiring note (separate PR)

A wiring PR will be needed to add `siege-bow` to:

- `src/shared/items.ts` — new `wpn('siege-bow', 'Siege Bow', ...)` entry
- `src/shared/equipmentDefs.ts` — weapon equipment def linking to a `WeaponDef`
- `src/shared/weaponDefs.ts` — define the siege bow's weapon mechanics
- `plans/item-icons/weapons.art.yaml` — add to weapons art plan

Co-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>
