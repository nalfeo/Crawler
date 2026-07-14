# Handoff — floor art asset-plan tracker

## What shipped

Implemented a data-driven tracker for theme/floor art requirements so teams can
see what still runs on placeholders versus what is briefed, approved, and
integrated.

### New command

- `npm run sprites:asset-plan -- --plan <path>`
  - Loads an `.art.yaml` plan file.
  - Reconciles each asset against:
    - committed sprite briefs in `briefs/**/*.yaml` (excluding draft and
      non-brief YAML),
    - approved generated-sprite manifest entries, and
    - runtime integration targets (`sprite-registry` or `item-catalog`).
  - Emits table or JSON report and can fail CI/local checks with
    `--fail-on-placeholder`.

## Files added

- `scripts/sprites/asset-plan.ts`
  - Zod schemas for floor/theme art plans.
  - Brief discovery and manifest ingestion.
  - Multi-axis status computation and summary counts.
- `scripts/sprites/asset-plan-cli.ts`
  - CLI parser + table/json output.
- `plans/floor-art/rat-themed-dungeon-floor.art.yaml`
  - Example plan decomposing a rat-themed floor into enemy/tile/prop assets.
- `tests/unit/sprites/asset-plan.test.ts`
  - Status derivation and discovery tests.
- `tests/unit/sprites/asset-plan-cli.test.ts`
  - CLI arg parsing tests.

## Files updated

- `package.json`
  - Added script: `"sprites:asset-plan": "tsx scripts/sprites/asset-plan-cli.ts"`.
- `briefs/README.md`
  - Added guidance for floor/theme art plans and tracker usage.

## Notes

- Plan files are intentionally outside `briefs/` (`plans/floor-art/`) to avoid
  conflicts with existing `briefs/**/*.yaml` batch/sweep flows.
