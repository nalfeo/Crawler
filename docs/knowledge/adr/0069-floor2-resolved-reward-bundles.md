# ADR 0069: Floor 2 Resolved Equipment Reward Bundles

## Status

Accepted

## Date

2026-07-23

## Estimated Complexity

🍎🍎🍎🍎🍎 — spans core (claim primitive, registry transaction), game (resolver,
carryover, achievement unlock), and engine (achievements UI) layers; touches
determinism, persistence, and the exactly-once reward contract.

## Context

Floor 2 achievements grant an **equipment** reward. The naive implementation would
generate equipment instances lazily at claim time or presentation time, but that
approach re-invokes the generator on every load/claim/render — which is (a)
non-deterministic across save/load unless the RNG stream is perfectly reproduced,
(b) vulnerable to double-claim if the generator is re-run, and (c) couples the
presentation layer to the generator.

We need an equipment reward that is resolved **once**, at achievement unlock, into
an immutable set of concrete generated-equipment instances, persisted across floor
transitions and save/load, and claimed **exactly once** — with the generator never
re-invoked on the load/claim/presentation paths.

This decision affects three systems (achievements, generated-equipment/registry,
carryover) across the `src/core`, `src/game`, and `src/engine` layers, so it
requires an ADR.

## Decision

Introduce **resolved reward bundles** (`GeneratedEquipmentRewardBundleV1`): a fixed
3-item bundle (always one Common + one Uncommon + one Rare generated-equipment
instance, in that canonical order) resolved at unlock and persisted versioned.

Key architectural rules:

1. **Resolve before mutate.** `unlockAchievement` resolves the bundle _before_
   mutating `unlockedIds`/`pendingUnlockIds`. If resolution throws, the achievement
   does not unlock (fail-closed). Resolution is idempotent — re-entry with an
   already-resolved bundle is a no-op early return.

2. **Snapshot inputs.** The resolver snapshots player level and build affinity
   (active weapon type → `magic`/`physical`) at resolve time so the bundle is a
   pure function of the snapshot, not of live mutable state.

3. **Bundle-specific deterministic RNG isolation.** Each rarity/decision draws from
   its own `new SeededRandom(hashStringToSeed('reward-bundle:v1:<runKey>:<achievementId>:<rarity>:<decision>'))`,
   consuming **zero** `world.rng`. This guarantees deterministic replay with no RNG
   contamination of the shared world stream.

4. **Scratch-registry transaction.** Generation happens into a cloned scratch
   registry (`createGeneratedEquipmentRegistryTransaction`). All candidates are
   validated; only an all-valid transaction is atomically committed via a single
   no-throw WeakMap state swap. A throw before commit leaves the live registry
   untouched (rollback-on-failure).

5. **Persist ordering.** On carryover, the bundle map is reconstructed immediately
   after registry restore and before bag/equipped/bundle references, and is
   semantically validated (known equipment-reward achievement, unlocked, not
   already claimed, exactly-3 in canonical rarity order). Malformed/stale bundles
   fail closed.

6. **Atomic exactly-once claim.** `claimGeneratedEquipmentRewardBundle` validates
   all destinations (bundle exists, exactly-3 canonical-rarity shape, each key
   present in registry, bag capacity) **before** any mutation, then swaps atomically
   (delete bundle + transfer references). Second claim returns `alreadyClaimed`.
   The claim/load/presentation paths **never** invoke the generator.

7. **Affinity probabilities.** Per-rarity independent alignment roll
   `rng.next() < AFFINITY_PROB[rarity]` with Common 0.25 / Uncommon 0.50 / Rare 0.75.
   Success → aligned base pool, else non-aligned. Rarity effect contracts:
   Common 0 stat effects, Uncommon ≤1 minor floor-scaled boost, Rare ≤2. A globally
   valid but contract-violating ambient policy fails closed with
   `illegal-effect-budget`.

8. **Floor 1 unchanged.** Floor 1 remains equipment-free (gold + common-material
   only). Equipment reward unlock is gated on
   `getFloor2EquipmentRewardsAccess(world).kind === 'enabled'`.

## Consequences

### Positive

- Deterministic, replay-stable reward that survives save/load and floor carryover.
- Exactly-once claim with atomic all-or-nothing semantics and fail-closed loads.
- Generator isolated to the unlock path; presentation/claim/load never re-roll.
- No contamination of the shared `world.rng` stream.

### Negative / Risks

- Persisted bundle schema is versioned (`V1`); future rarity/shape changes need a
  migration or a fail-closed rejection path.
- The fixed 3-item shape is a design constraint; variable-size bundles would need a
  schema and validator change.

### Deviation note

The literal parent plan named an economy-access helper for the unlock gate; the
implementation gates on the semantically-correct
`getFloor2EquipmentRewardsAccess` (flag `floor2EquipmentRewards`) instead. This is
strictly narrower and weakens no existing gate.

## Alternatives Considered

1. **Lazy generation at claim time** — rejected: re-invokes the generator on every
   claim, is non-deterministic across load unless the RNG stream is perfectly
   reproduced, and is double-claim-prone.
2. **Variable-size / conditional bundles (only aligned rarities present)** —
   rejected via the adversarial plan review (`major_fork`): a fixed
   Common+Uncommon+Rare shape gives a stable validator, simpler persistence, and a
   predictable reward, while conditional alignment is expressed through the
   aligned-vs-non-aligned pool choice rather than presence/absence.
3. **In-place live-registry generation with rollback bookkeeping** — rejected: a
   cloned scratch transaction with a single WeakMap commit swap is simpler to prove
   atomic than unwinding partial mutations on the live registry.

### Amendment (2026-07-31): base identity decoupled from non-armor rarity power

Generated equipment no longer copies non-armor base stat bonuses into resolved
instances. Inherent armor remains base-driven and level/rarity-scaled, while
non-armor power is affix-budget driven by rarity (Common 0, Uncommon 1, Rare 2).
This makes the Common non-armor contract hold by construction and removes the
need for resolver-time base-category prefiltering.
