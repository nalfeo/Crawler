# Handoff: Floor 2 Slice 8 — scenario wiring + Governor sweep + Director surfaces

## Date

2026-07-03

## Summary

- Added a scenario-definition registry (`src/game/scenarioDefinitions.ts`) and wired floor selection into:
  - visual options builder (`src/bootstrap/floor-main-scene-options.ts`)
  - headless runner + CLI (`src/game/ai/headless-runner.ts`, `src/game/ai/headless-runner-cli.ts`)
- Implemented `initializeFloor2Scenario` in `src/game/floor2Scenario.ts`, composing existing Floor 2 slices:
  - manifest-driven biome map generation via biome registry
  - seeded family/resource selection and relation init
  - boss/den initialization and settlement/shop initialization
  - floor objective tick registration
- Extended floor manifest schema/loader + floor registry for Floor 2 and Floor 2-specific config fields.
- Updated CaveSystem generator to consume `MapConfig.caveSystem.presentCount`.
- Replaced Governor sweep stub with deterministic multi-floor sweep (`scripts/agent/health/governor-playthroughs.ts`).
- Added telemetry artifact: `docs/knowledge/metrics/floor2-slice8-governor-sweep.json`.

## Verification run

- ✅ `npm run verify:fast`
- ✅ `npm run verify` passes on the current head (CI `Format & Labs` + `Types & Lint` green; earlier local Prettier drift resolved).
- ⚠️ `npm run verify:pr-prereqs` initially failed for missing handoff/ADR/review-ledger; mitigated by adding:
  - this handoff
  - ADR 0043
  - review ledger `docs/knowledge/review-ledgers/2026-07-03-floor2-slice8-scenario-wiring.review-ledger.json`
- ✅ Governor sweep:
  - `LOG_LEVEL=error npx tsx scripts/agent/health/governor-playthroughs.ts`
  - Floor1 98.3% (59/60), Floor2 0% (0/20 — expected at this slice; Win A / Win B objective-complete wiring not yet productionised), Combined 73.75% (59/80); combinedGate FAIL (expected for this slice)

## Files touched (high level)

- Scenario wiring: `src/game/scenarioDefinitions.ts`, `src/bootstrap/floor-main-scene-options.ts`, `src/game/index.ts`
- Floor 2 init/objective: `src/game/floor2Scenario.ts`
- Manifest + registry: `src/shared/floor-manifest.ts`, `src/shared/floor-registry.ts`, `src/shared/data/floors/floor2.manifest.json`
- Map config/generator: `src/shared/map-types.ts`, `src/core/map/generators/cave-system.ts`
- Headless/governor: `src/game/ai/headless-runner.ts`, `src/game/ai/headless-runner-cli.ts`, `scripts/agent/perf/winrate-sweep.ts`, `scripts/agent/health/governor-playthroughs.ts`
- Tests: `tests/unit/scenario-definitions.test.ts`, `tests/unit/floor-manifests-lighting.test.ts`, `tests/unit/floor-registry.test.ts`, `tests/game/floor1-main-scene-options.test.ts`

## Tuning suggestions captured

See `docs/knowledge/metrics/floor2-slice8-governor-sweep.json`:

1. Keep Governor budget at >=30000 frames for stable Floor 1 rate checks.
2. Keep Floor 2 `autoVictoryOnStart` disabled and complete Win A / Win B objective-closeout wiring in production mode.
3. Re-run sweep after objective-closeout wiring and retune if Floor 2 remains below 90%.

## Outstanding risks / next steps

- Complete Floor 2 Win A / Win B objective-closeout production wiring, then re-run governor sweep to validate >=90% Floor 2 win rate.
