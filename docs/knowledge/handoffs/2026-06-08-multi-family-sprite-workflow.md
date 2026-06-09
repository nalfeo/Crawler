# Handoff — multi-family sprite workflow

## What shipped

Extended the sprite-generation workflow beyond weapons so floor/theme plans can now drive draft brief creation for enemies/mobs, items/props/decor, tiles, and VFX/flair.

### New workflow surface

- Added `npm run sprites:plan-drafts -- --plan <plan.art.yaml> [--type ...] [--status ...] [--force] [--dry-run]`
  - Reads an art plan.
  - Computes current lifecycle state using committed briefs, draft briefs, approvals, and integration.
  - Materializes runnable minimal draft briefs under `briefs/draft/<family>/`.
  - Honors canonical `briefId` when present instead of assuming `asset.id`.
  - Supports optional `briefOverrides` in art-plan entries for per-asset brief customization.

### Family defaults added

Committed sprite-type defaults for:

- `data/sprite-types/enemy.json`
- `data/sprite-types/item.json`
- `data/sprite-types/tile.json`
- `data/sprite-types/vfx.json`
- `data/sprite-types/character.json`

These make minimal non-weapon briefs runnable through the existing `sprites:run` / `sprites:batch` pipeline without needing fully specified YAML.

### Visibility improvements

Art-plan reporting now distinguishes committed briefs from draft briefs:

- new statuses: `draft-ready`, `draft-ready-placeholder`
- CLI report includes a `draft` column
- DevTools shows drafted assets and a “Drafts ready” summary card

## Files added

- `scripts/sprites/brief-paths.ts`
- `scripts/sprites/plan-drafts.ts`
- `scripts/sprites/plan-drafts-cli.ts`
- `data/sprite-types/{enemy,item,tile,vfx,character}.json`
- `tests/unit/sprites/plan-drafts.test.ts`
- `tests/unit/sprites/plan-drafts-cli.test.ts`

## Files updated

- `scripts/sprites/asset-plan.ts`
- `scripts/sprites/asset-plan-cli.ts`
- `src/shared/art-plan-status.ts`
- `src/devtools/art-plan-model.ts`
- `src/devtools-main.ts`
- `briefs/README.md`
- `package.json`
- tests covering asset-plan/devtools status behavior

## Validation

- `npm run typecheck`
- `npm run lint`
- `npx vitest run --project unit tests/unit/sprites/asset-plan.test.ts tests/unit/sprites/plan-drafts.test.ts tests/unit/sprites/plan-drafts-cli.test.ts tests/unit/devtools-art-plan-model.test.ts`
- `npm run sprites:plan-drafts -- --plan plans/floor-art/rat-themed-dungeon-floor.art.yaml --dry-run`
- `npm run sprites:asset-plan -- --plan plans/floor-art/rat-themed-dungeon-floor.art.yaml`

## Notes

- `npm run verify:fast` appeared to stall in this Windows session during the unit-test phase, so validation used the equivalent targeted checks above instead.
- `sprites:plan-drafts` defaults to assets still missing art (`needs-art-placeholder`, `planned`). To re-materialize existing drafts, pass `--status draft-ready-placeholder` / `--status draft-ready` and `--force`.
