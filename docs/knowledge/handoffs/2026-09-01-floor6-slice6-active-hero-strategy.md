# Handoff: Floor 6 Slice 6 — active hero strategy

## Systems touched

ai-behavior-tree, ai-pathfinding, inventory, weapons, enemies

## Apples

5 apples estimated, 5 apples actual (exact). The slice stayed within the declared 5-apple cap while touching headless AI decisions, build-currency pickup targeting, Floor 6 combat contribution telemetry, and real-pipeline tests.

## Summary

Implemented the Floor 6 Slice 6 active-Crawler/headless automation seam without changing combat ownership or adding a detached build-cursor path:

- Added `BuildCurrencyPickup` to the existing BehaviorTree loot/tactical/travel pickup paths so the AI deliberately collects Floor 6 requisitions through normal movement and pickup collision.
- Added a deterministic Floor 6 headless strategy that, only when callers did not provide explicit scripted tower requests, reads public Floor 6 state/manifest data to choose build sites, build affordable towers, and purchase affordable upgrade offers through the existing transaction helpers.
- Added Floor 6 hero-vs-tower contribution telemetry by observing the existing combat-event stream in the Floor 6 director; non-tower damage to Floor 6 raiders counts as hero damage, tower-source hits count as tower damage.
- Locked Floor 6 into the canonical shared scenario system-order test so windowed/headless pipelines retain normal Crawler weapon/input/enemy systems with Floor 6 systems only in their approved slots.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
- `src/game/ai/headless-runner.ts`
- `src/game/ai/tactical-opportunity-evaluator.ts`
- `src/game/ai/travel-steering.ts`
- `src/game/floor6Scenario.ts`
- `src/shared/floor-types.ts`
- `tests/game/floor1-main-scene-options.test.ts`
- `tests/headless/floor6-economy-obs.test.ts`
- `tests/unit/floor6-towers.test.ts`
- `docs/knowledge/metrics/apples/2026-09-01-floor6-slice6-active-hero-strategy.json`

## Verification run

- `bash scripts/agent/preflight.sh` — passed before code changes.
- `npx vitest run --project unit tests/unit/floor6-towers.test.ts tests/game/floor1-main-scene-options.test.ts` — failed once while the synthetic tower-only fixture was not registered in `liveEnemies`; fixed by also accepting a current `BroadcastRelayRaider` component as public raider evidence.
- `npx vitest run --project unit tests/unit/floor6-towers.test.ts tests/game/floor1-main-scene-options.test.ts` — passed.
- `npx vitest run --project headless tests/headless/floor6-economy-obs.test.ts` — passed.
- `npx prettier --write src/shared/floor-types.ts src/game/floor6Scenario.ts src/game/ai/bt-ai-provider.ts src/game/ai/tactical-opportunity-evaluator.ts src/game/ai/headless-runner.ts tests/game/floor1-main-scene-options.test.ts tests/headless/floor6-economy-obs.test.ts tests/unit/floor6-towers.test.ts` — completed; only `bt-ai-provider.ts` formatting changed.
- `bash scripts/agent/verify-fast.sh` — failed once on `TravelPickup.kind` not accepting `buildCurrency`; fixed by widening the matching pure travel-steering debug/input type.
- `bash scripts/agent/verify-fast.sh` — passed.
- `npm run verify:pr-prereqs` — failed before this handoff existed; rerun after this handoff is expected next.

## Runtime observation

- Before: the real Floor 6 headless run could collect ordinary loot and sometimes requisitions, but no default strategy purchased upgrades or chose/build towers unless the test supplied scripted `floor6TowerBuildRequests`.
- After: `tests/headless/floor6-economy-obs.test.ts` runs the real `runHeadless(new BehaviorTreeAI({ seed: 606 }), { floorId: 'floor6', seed: 606 })` pipeline twice and observes deterministic Floor 6 telemetry with ordinary kills/loot, build-currency pickups, at least one strategy-built tower, at least one purchased upgrade, and both hero and tower damage contributions.
- Tower-only acceptance guard: `tests/unit/floor6-towers.test.ts` proves a tower hit increments `towerDamageDealt` while leaving `heroDamageDealt` at `0`, so a hero-gated S6 acceptance case cannot be satisfied by towers alone.

## Unresolved issues

- Floor 6 still has no terminal victory path; that remains Slice 7 per the Floor 6 epic/spec.
- Numeric balance and release-rate tuning remain HUMAN_GATE/Slice 9 work; this slice did not retune tower, wave, economy, or enemy values.

## Recommended next steps

- Rerun `npm run verify:pr-prereqs` after this handoff is committed.
- Run the required 5-apple post-diff review process and CodeQL checker before finalizing.
- Let Slice 7 consume the new `heroDamageDealt` / `towerDamageDealt` telemetry if it needs an explicit finale acceptance gate.
