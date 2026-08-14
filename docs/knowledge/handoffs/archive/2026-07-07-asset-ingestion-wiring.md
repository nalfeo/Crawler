# Handoff: Asset ingestion wiring (rat nest + slime pool)

## Date

2026-07-07

## Systems touched

vfx, sprite-pipeline, docs-tooling

## Summary

- Pulled `assets/checkin-20260706-231959-2f2625` into this branch (5 approved assets).
- Ran canonical ingestion/wiring flows:
  - `npm run sprites:generate-wiring -- --since main`
  - `npm run sprites:placeholder-audit -- --since main`
- Wired real runtime usage for new spawner art in `PhaserBridge`:
  - Rats-nest spawners now resolve to `enemy_spawner_rats_nest` (`rat-nest-v2`).
  - Slime-pool spawners now resolve to `enemy_spawner_slime_pool` (`slime-pool-v1`).
  - Placeholder red wash now only applies when a spawner has no dedicated wired art.
- Added render-kind mappings for the two new spawner families in `src/shared/data/entity-sprite-mappings.json`.
- Updated tests for new spawner generated-family selection + runtime rendering behavior.
- Updated floor art plan metadata to reflect shipped rat/slime spawner props (`placeholderInUse: false`, explicit brief IDs).

## Files changed (non-asset wiring work)

- `src/engine/PhaserBridge.ts`
- `src/engine/phaser-bridge/sprite-kind.ts`
- `src/shared/data/entity-sprite-mappings.json`
- `tests/unit/phaser-bridge.test.ts`
- `tests/unit/phaser-bridge-sprite-kind.test.ts`
- `plans/floor-art/rat-themed-dungeon-floor.art.yaml`
- `docs/knowledge/review-ledgers/2026-07-07-asset-ingestion-wiring.review-ledger.json`

## Verification

- `npm run sprites:generate-wiring -- --since main` → 12 replaceable placeholders found overall; **0 code patches generated** (manifest-only replacements in current dataset).
- `npm run sprites:placeholder-audit -- --since main` → `rat-nest`/`slime-pool` reported as new real assets; no direct placeholder auto-replacement for these concepts.
- `npm run verify:fast` → **pass** (54 files, 601 tests).
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-07-asset-ingestion-wiring.review-ledger.json` → **valid 2-apple ledger**.
- `npm run verify` currently fails in this Windows worktree on pre-existing `tests/unit/detect-change-scope.test.ts` path resolution (`detect-art-only.sh` path flattening); unrelated to wiring changes.

## Next steps

- User-requested follow-up: after this PR merges, do a dedicated pass to slim CI for asset-ingestion PRs to the bare minimum required checks (reduce turnaround time).
