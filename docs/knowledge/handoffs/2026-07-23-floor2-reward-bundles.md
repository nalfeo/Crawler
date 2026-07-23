# Session Handoff: Floor 2 Resolved Equipment Reward Bundles

## Date

2026-07-23

## Persona

Producer → Systems Engineer (Floor 2 equipment epic E2 slice)

## Systems touched

quests, inventory, weapons

## Apples

5🍎 estimated, 5🍎 actual (exact — adversarial fork landed the fixed 3-item design
pre-code; full JSON in docs/knowledge/metrics/apples/2026-07-23-floor2-reward-bundles.json).

## What Was Done

Implemented the Floor 2 "resolved reward bundles" slice on top of the carryover base
(PR #1564, squash `6162b732b`). An achievement's equipment reward is now resolved ONCE
at unlock into an immutable 3-item bundle (one Common + one Uncommon + one Rare generated
instance, in that canonical order), persisted versioned, and claimed exactly-once — the
generator is never re-invoked on the load/claim/presentation paths.

- **Resolver** (`src/game/floor2-reward-bundle-resolver.ts`): snapshots player level +
  build affinity (active weapon → `magic`/`physical`); per-rarity independent alignment
  roll `rng.next() < AFFINITY_PROB[rarity]` (Common .25 / Uncommon .50 / Rare .75) using
  bundle-specific `new SeededRandom(hashStringToSeed('reward-bundle:v1:<runKey>:<achievementId>:<rarity>:<decision>'))`
  — zero `world.rng` consumption. Fail-closed `illegal-effect-budget` if ambient policy
  violates the rarity effect contract (Common 0 / Uncommon ≤1 / Rare ≤2).
- **Registry transaction** (`createGeneratedEquipmentRegistryTransaction`): generate into
  a cloned scratch registry, validate all candidates, atomically commit via a single
  no-throw WeakMap state swap; a throw before commit leaves the live registry untouched.
- **Unlock ordering** (`src/game/systems/achievementSystem.ts` `unlockAchievement`):
  resolve BEFORE mutating unlockedIds; gate on
  `getFloor2EquipmentRewardsAccess(world).kind === 'enabled'`; idempotent re-entry.
- **Carryover** (`src/game/playerCarryover.ts`): bundle map rebuilt immediately after
  registry restore, before bag/equipped references; semantic + shape validation
  (exactly-3, canonical rarity order, known/unlocked/unclaimed) — fail-closed on
  stale/malformed.
- **Claim primitive** (`src/core/systems/equipmentSystem.ts`
  `claimGeneratedEquipmentRewardBundle`): validates all destinations (shape, per-index
  rarity, registry presence, bag capacity) BEFORE any mutation, then swaps atomically;
  second claim = `alreadyClaimed`.
- **UI** (`src/engine/AchievementsUI.ts`): equipment reward switch arm.

Floor 1 remains equipment-free (gold + common-material only) — verified by the Floor 1
exclusion test.

**Runtime/real-artifact observation (rule #10):** Observed through the real
`achievementSystem(world)` runtime tick (wired via
`src/bootstrap/floor-main-scene-options.ts`), not lab-only. The integration test
`tests/integration/floor2-reward-bundle-claim.integration.test.ts` drives the real
unlock→resolve→carryover→claim flow. Before: an unlocked Floor 2 equipment achievement had
no resolved bundle and claim produced nothing deterministic; after: unlock resolves a
stable Common/Uncommon/Rare bundle, carryover preserves it, and a single claim transfers
exactly those three instances into the bag while a second claim returns `alreadyClaimed`.

## Key Decisions Made

- **Fixed 3-item bundle** (Common+Uncommon+Rare always) over conditional/variable-size
  bundles — adopted from the adversarial plan review (`plan_divergence: major_fork`).
  Rationale + alternatives recorded in ADR 0069.
- **Bundle-specific SeededRandom isolation** so resolution is a pure function of the
  snapshot with zero contamination of the shared world RNG stream.
- **Scratch-registry transaction with single WeakMap commit swap** for provable atomic
  rollback-on-failure, over in-place mutation with unwind bookkeeping.
- **Flag-gate deviation:** unlock gates on `getFloor2EquipmentRewardsAccess` (flag
  `floor2EquipmentRewards`) rather than the economy helper the literal parent plan named.
  Semantically narrower; weakens no existing gate. Called out in ADR 0069.

## What's Next / Blockers

- No blockers. All targeted unit/property/integration tests + `verify:fast` + full
  integration project (163 tests) green; typecheck clean; `check:wired-systems` clean;
  5🍎 review ledger valid.
- Next: publish non-draft PR, arm `gh pr merge --auto --squash`, report PR + merge SHA to
  parent `d014bdcd-ea9f-4393-a2f2-a667927d2e51`.
- Future slices in the Floor 2 equipment epic (E2 continuation) can build on the resolved
  bundle + claim primitives established here.

## Retrospective

### Lessons Learned

- The generated-equipment registry validator enforces the effect budget **exactly**
  (`RARITY_EFFECT_BUDGET`: common 0, uncommon 1, rare 2). Test fixtures MUST emit exactly
  that many effect units for the chosen rarity or `createGeneratedEquipmentInstance`
  throws — the fixture now takes an optional `rarity` and emits matching effects.
- `verify:fast` skips the integration vitest project, so a new carryover semantic guard
  can pass `verify:fast` yet break a pre-existing integration test. Run
  `npx vitest run --project integration` before assuming green.
- Guard ordering matters: the carryover length guard runs before the per-key claim/rarity
  check, so a "dangling key" test must keep length 3 (swap one real key for a dangling
  one) to reach the dangling-detection path rather than tripping the length guard first.
- Multi-model review ledger rounds require `valid_count` (not just `concerns_count` +
  `resolved_count`); the plain code_review rounds do not.
- The canonical bundle-rarity order constant lives in `src/shared/` so the core-layer
  claim path and game-layer resolver/carryover agree without violating the
  core-must-not-import-game ESLint rule.

### Mistakes Made

- Initially built the fail-closed regression tests with mismatched effect-unit counts on
  the uncommon/rare fixture instances — the registry validator rejected them before the
  test's own assertion ran. Early signal: a `GeneratedEquipmentRegistryError: Rarity X
requires exactly N effect units` means the fixture, not the code under test, is wrong.
- Reworked the dangling-key carryover test twice because the new length guard fired before
  the dangling path. Should have traced guard ordering before writing the test.

### Opportunities for Future Improvement

- Consider a shared test-helper that builds a canonical well-formed 3-item bundle so each
  new test doesn't hand-assemble instances (and re-discover the exact-budget rule).
- A versioned-bundle migration path is not yet needed (only V1 exists) but will be when
  the rarity/shape contract changes — worth a dedicated slice before that lands.
