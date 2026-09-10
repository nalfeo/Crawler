# ADR 0100: Floor 6 Slice 4 — run-scoped build currency and deterministic upgrade offers

## Status

Accepted

## Date

2026-09-01

## Estimated Complexity

🍎 x 4 — cross-layer Floor 6 economy/data/runtime/testing change: ECS pickup primitive, manifest validation, scenario director rewards, run stats, and headless observation.

## Context

Floor 6 Slice 4 implements the economy contract from the Floor 6 spec (`FR4`, `FR9.2`):

- Enemy and wave rewards must be authored data.
- Build currency is floor-scoped and must not mix with persistent inventory or gold.
- Upgrade offers must use stable IDs, an isolated `upgrades` RNG stream, and without-replacement manifests.
- Rejected, duplicate, and unaffordable purchase attempts must be atomic no-ops.
- Missed pickups cannot soft-lock mandatory upgrade progression.
- Economy state must reset at terminal cleanup and not leak into another run.

The predecessor Slice 3 director already owns Floor 6 phase, wave manifests, raider lifecycle, and terminal cleanup (ADR 0099). Ordinary loot is already handled by the core `dropSystem` and `itemPickupSystem`.

## Decisions

### D1 — Build currency is a core pickup component, credited only to Floor 6 state

Add `BuildCurrencyPickup` as a small ECS pickup primitive in `src/core/components.ts`, with a spawn helper in `src/core/spawners/pickups.ts`. `itemPickupSystem` credits the pickup to `world.floorExtendedState.floor6Defense.economy` when present and never mutates `world.playerGold` or the player's persistent inventory.

### D2 — Floor 6 economy values and upgrade effects are manifest data

Enemy build-currency rewards, wave rewards, offer count, costs, and upgrade effect values live under `floor6.economy` and `floor6.upgrades` in `src/shared/data/floors/floor6.manifest.json`. `src/shared/floor-manifest.ts` validates duplicate IDs, known Floor 6 archetypes, valid wave indexes, and offer-count bounds at load time.

### D3 — Raider deaths spawn collectible build currency; wave clears credit mandatory progress

When the Floor 6 director reconciles a dead raider, it spawns one build-currency pickup at the raider's position and latches the reward on that wave-manifest record. Wave rewards are credited directly, once per fully resolved wave. This preserves collectible enemy currency while guaranteeing missed/skipped pickups cannot block the first upgrade.

### D4 — Upgrade offers are generated once from the isolated `upgrades` stream

At `SETUP → DEFEND`, the director builds a frozen offer manifest by sampling the stable sorted authored offer pool without replacement using a `SeededRandom` derived from `state.rngStreamKeys.upgrades`. The world combat RNG is not consumed, so combat timing, loot scatter, and pickup timing cannot perturb offers.

### D5 — Purchase/selection is a transaction helper, not UI ownership

`purchaseFloor6UpgradeOffer` is the single Slice 4 transaction helper. It rejects unknown, duplicate, or unaffordable offers without changing balance or selected offers, while still appending telemetry to the selection trace. UI and future Floor 6 AI slices may call this helper, but they do not own costs, effects, or balance mutation.

### D6 — Terminal cleanup resets mutable floor-scoped state once

Floor 6 terminal cleanup removes live build-currency pickups, clears upgrade offers, zeroes mutable economy state, and increments a reset counter. Cumulative player gold, inventory, XP, and ordinary loot ledgers remain outside this state and are not used to pay for Floor 6 construction.

## Consequences

### Positive

- Floor 6 construction resources are separated from persistent inventory/gold.
- Costs and effects are data-driven and schema-validated.
- The first upgrade cannot be soft-locked by missed enemy pickups because wave-clear rewards provide mandatory progress.
- Offer determinism is isolated from combat RNG and covered by tests.
- The real headless pipeline now reports ordinary loot collection plus Floor 6 build-currency/upgrades in `RunStats.floor6Defense`.

### Negative

- One new pickup component/store is allocated in every world, even though only Floor 6 currently spawns it.
- `itemPickupSystem` now has a small Floor 6 state branch; this is intentionally narrow but still a cross-floor core seam.
- Slice 4 records upgrade effects but does not apply tower combat/site effects yet; Slice 5 owns those mechanics.

### Risks

- Future UI or AI code could bypass the transaction helper and mutate economy state directly. Tests cover the helper; review should reject hard-coded costs/effects in UI/prose.
- Future terminal paths must continue using the shared Floor 6 cleanup helper so build-currency pickups and offers cannot leak.
- If Slice 5 changes the meaning of upgrade effects, it must preserve stable offer IDs or explicitly document a seed-breaking migration.

## Alternatives Considered

1. **Use `Gold` pickups for build currency.** Rejected: it would mix construction resources with persistent player gold and violate `FR4.3`.
2. **Auto-credit all enemy build currency on death.** Rejected: the issue explicitly calls for collectible build currency. Wave rewards provide the non-soft-lock guarantee instead.
3. **Generate offers from `world.rng`.** Rejected: combat/drop timing also consumes `world.rng`, so offers would vary with unrelated timing.
4. **Auto-purchase upgrades in the headless runner.** Rejected for Slice 4: purchase policy is a future AI/UX decision. This slice exposes deterministic transactions and proves real-pipeline unlocks without adding an implicit gameplay strategy.
