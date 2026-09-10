# Handoff: Floor 6 Slice 4 — run-scoped economy

## Systems touched

enemies, inventory, ai-behavior-tree

## Apples

4 apples estimated, 4 apples actual (exact). The work spans manifest validation, a core pickup primitive, Floor 6 director runtime state, run telemetry, and focused/property/headless tests.

## Summary

Implemented the approved Floor 6 Slice 4 economy contract:

- Added a floor-scoped build-currency pickup primitive that credits `floor6Defense.economy` without mutating persistent `playerGold` or inventory.
- Added validated Floor 6 manifest data for enemy build-currency rewards, wave rewards, and run-scoped upgrade offers.
- Built seeded without-replacement upgrade offers from the isolated `upgrades` stream at `SETUP → DEFEND`.
- Spawned collectible build-currency rewards on raider death while crediting wave-clear rewards directly so missed pickups cannot soft-lock the first upgrade.
- Added atomic `purchaseFloor6UpgradeOffer` transactions for unknown/duplicate/unaffordable/successful selections.
- Added terminal cleanup that removes build-currency pickups, clears offers, zeroes Floor 6 economy state, and increments a reset counter.
- Extended `RunStats.floor6Defense` with currency, offer, unlock, selection, and reset telemetry.

## Files touched

- `src/core/components.ts`
- `src/core/spawners/pickups.ts`
- `src/core/systems/itemPickupSystem.ts`
- `src/core/world.ts`
- `src/game/floor6Scenario.ts`
- `src/shared/data/floors/floor6.manifest.json`
- `src/shared/floor-manifest.ts`
- `src/shared/floor-types.ts`
- `tests/unit/floor6-economy.test.ts`
- `tests/headless/floor6-economy-obs.test.ts`
- `docs/knowledge/adr/0100-floor6-slice4-run-scoped-economy.md`

## Verification run

- `npx vitest run --project unit tests/unit/floor6-economy.test.ts`
- `npx vitest run --project headless tests/headless/floor6-economy-obs.test.ts tests/headless/floor6-wave-director-obs.test.ts`
- `npx vitest run --project unit tests/unit/floor6-wave-director.test.ts tests/unit/floor6-economy.test.ts`
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`
- Post-review reruns:
  - `npx vitest run --project unit tests/unit/floor6-economy.test.ts tests/unit/floor6-wave-director.test.ts`
  - `npm run typecheck`
  - `npx vitest run --project headless tests/headless/floor6-economy-obs.test.ts tests/headless/floor6-wave-director-obs.test.ts`

Observed before implementation: a seed-606 Floor 6 `runHeadless` BehaviorTree run killed 6 raiders and collected ordinary XP/gold, but `RunStats.floor6Defense` had no economy/offer telemetry.

Observed after implementation: the same seed-606 real headless pipeline killed 6 raiders, collected ordinary XP/gold, collected 5 Floor 6 build-currency pickups, reached `buildCurrencyBalance=8`, and unlocked all 3 generated upgrade offers.

Post-diff review found that `stallResolved` was too broad for wave-reward gating and that reset telemetry could be zeroed on a same-world re-setup. The fix added a separate defeated/missing latch for rewards, preserved reset telemetry across `SETUP`, and added regression tests for stalled-live raiders, later death after stall, reset-count preservation, and capped selection telemetry.

## Unresolved issues

- Slice 4 intentionally does not apply tower/site combat effects; Slice 5 owns construction, tower behavior, and any effect application.
- Headless AI does not auto-purchase upgrades in this slice. The transaction helper is deterministic and covered, while purchase strategy remains a later AI/UX policy decision.
- Final S9 balance values remain `HUMAN_GATE`; this slice only adds operational defaults and deterministic contracts.

## Recommended next steps

- Slice 5 should consume `selectedOfferIds`/offer effects through the transaction helper rather than hard-coding costs or effects.
- UI work should read costs/effects from the manifest-backed offer state and must not duplicate values in presentation code or prose.
- If future terminal paths are added, route them through Floor 6 terminal cleanup so build-currency pickups/offers cannot leak.
