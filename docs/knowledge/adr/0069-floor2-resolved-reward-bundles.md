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

### Amendment (2026-07-30): `lootBox`/`lootTable` discriminator and a central Floor 2 reward pool

The `floor2-inventory-reward-pool` slice needed all 36 real Floor 2 achievements
to grant rewards, and the human required Floor 2's player-facing reward concept
to be named `lootBox` — the same nomenclature Floor 1's gold/materials reward
already used — rather than reviving the separate `'equipment'` reward type this
ADR originally shipped. Unifying the name without losing type safety required a
few structural additions layered on top of the resolved-bundle architecture
above (unchanged):

1. **Named loot-table discriminator.** `AchievementReward`'s `lootBox` variant
   is now itself a nested Zod discriminated union on a new
   `lootTable: 'floor1-materials' | 'floor2-generated-equipment'` field
   (`ACHIEVEMENT_LOOT_TABLES` in `src/shared/achievements.ts`). Floor 1's
   `floor1-materials` payload (a `LootBoxTier`, gold/material grant, no
   equipment fields) and Floor 2's `floor2-generated-equipment` payload (a
   `Floor2AchievementLootTier`, resolved-bundle equipment grant) remain
   structurally distinguishable end-to-end — schema, parsing, achievement
   unlock routing, presentation, and carryover validation all switch on
   `lootTable`, never on reward shape alone. This let every Floor 1
   achievement (100 entries) and every Floor 2 achievement (36 entries) share
   one player-facing `type: 'lootBox'` concept without collapsing two
   materially different reward payloads into one ambiguous shape.
2. **Central, frozen Floor 2 reward pool.** `src/shared/data/floor2-reward-pool.ts`
   derives a single frozen 88-base pool (56 weapon + 32 non-weapon,
   `FLOOR2_REWARD_POOL_STABLE_IDS`/`_WEAPON_IDS`/`_NON_WEAPON_IDS`) from the
   existing 70 generator bases (Wave A + Wave B) plus the 18 new Classic
   Fantasy Basic Leather bases (see the ADR 0070 amendment below), with a
   load-time `validateRewardPool()` self-check (exact count, clean
   weapon/non-weapon partition, no duplicates, all 16 armor slots reachable).
   `resolveEquipmentRewardBundle`'s call site
   (`src/game/systems/achievementSystem.ts`) now passes this single frozen
   pool for **all 36** Floor 2 achievements, removing the previously repeated
   per-achievement 4-base candidate arrays entirely — a tier/rarity/build
   ladder no longer needs its own hand-maintained base list.
3. **Base stat bonuses are source-independent; Common eligibility is filtered,
   not the output.** Some pool bases (both pre-existing Wave B items and 3 of
   the new Basic Leather bases) intentionally carry an inherent non-armor stat
   bonus at their catalog-level Common definition (mirroring player-facing
   shop/starter-gear precedent). The existing "Common must have zero non-armor
   bonus" contract from `generated-equipment-generator.ts` is preserved, not
   weakened — but **not** by normalizing/stripping the generated instance's
   output. A base's inherent stat bonuses are part of its fixed identity: the
   same `baseId` must produce identical stats regardless of whether it is
   drawn from this reward pool, sold by the Quartermaster, or found in a boss
   chest. `resolveEquipmentRewardBundle` therefore rolls **rarity first**, then
   filters _candidacy_ — bases carrying an inherent non-armor bonus are
   excluded from the Common draw's candidate pool only; they remain fully
   eligible (bonus intact) for Uncommon/Rare draws of the same tier. See the
   correction below for how an earlier draft of this amendment got
   this wrong and how it was fixed.
4. **Neutral-armor affinity is unchanged and now explicitly tested.**
   `getGeneratedEquipmentBaseAffinity` already classified every non-weapon
   (armor/accessory) base as `'neutral'`, and `partitionBases` already treated
   "opposite affinity OR neutral" identically as the non-aligned pool — this
   amendment adds no new affinity behavior, it only adds dedicated coverage
   (`tests/unit/floor2-reward-bundle-resolver.test.ts`) proving a neutral base
   is reachable from the non-aligned pool for both physical- and magic-build
   players, and that the existing `empty-nonaligned-pool` fail-closed error is
   unaffected.

None of this touches `resolveGeneratedEquipmentBase` or the ADR 0068
generator-only catalog boundary: the reward pool is a curated **subset** of
IDs resolvable through the existing bridge, not a new catalog or a new bridge.

### Correction (2026-07-30): rarity-first eligibility filtering replaces provenance-dependent output normalization

An earlier draft of the amendment above proposed item 3 as a
`rewardCommonNormalization` option on `generateEquipmentInstance`: generate the
instance first, then strip its inherent non-armor bonus from the output _only_
when the caller was this reward resolver and the rolled rarity was Common. A
blocking plan-review correction identified this as a real design flaw: it made
the **same base's stats depend on where the item came from** (reward vs.
Quartermaster vs. boss chest), which violates a base's stat identity as fixed,
source-independent data — a strictly worse and more surprising outcome than
the thing it was trying to avoid.

The fix moves the decision from _output normalization_ to _candidate
eligibility_, before generation ever runs:

1. `resolveEquipmentRewardBundle` rolls the rarity **before** partitioning
   bases into aligned/non-aligned pools (previously rarity and pool selection
   were independent; now rarity gates candidacy).
2. When the rolled rarity is `common`, bases with an inherent non-armor stat
   bonus (`generatedEquipmentBaseHasNonArmorStatBonus`) are excluded from the
   candidate list _for that draw only_ — they are never removed from the
   88-base pool itself, and remain fully eligible, bonus intact, whenever the
   roll lands on `uncommon`/`rare`.
3. `generateEquipmentInstance` gained **no** provenance-aware parameter; the
   `rewardCommonNormalization` option was removed entirely. It always spreads
   a resolved base's stat bonuses onto the generated instance verbatim,
   regardless of caller. A defense-in-depth assertion
   (`generatedEquipmentInstanceHasNonArmorStatBonus`) still runs after
   generation and throws if a Common instance somehow has a non-armor bonus —
   now provably unreachable via the eligibility filter, but kept as a
   fail-loud guard against a future data change (e.g. a base's `statBonuses`
   changing) rather than trusted silently.
4. Both `aligned` and `nonAligned` candidate pools must remain non-empty for
   **every possible rolled rarity**, not just Common — the empty-pool
   fail-closed errors (`empty-aligned-pool`/`empty-nonaligned-pool`) now fire
   per-rarity-eligible-subset rather than against the raw achievement base
   list, and are covered by dedicated tests for physical/magic/neutral
   candidates at Common specifically (the rarity where the eligibility filter
   actually removes candidates).

### Note (2026-07-30): reward-opening icon now resolves via `frozen.artKey`, not `resolveItemSprite`-only

Confirming per-item art reachability for the 18 new Basic Leather bases
(during the correction above) surfaced a pre-existing, cross-cutting gap
shared by all 88 reward-pool bases equally, not introduced by this slice:
`RewardOpeningUI.ts`'s icon renderer (`src/engine/generated-equipment-icon.ts`)
resolved sprites by passing the instance's dotted `baseId`
(e.g. `weapon.iron-dagger`) into `resolveItemSprite`'s registry-`briefId`
matcher. Since ADR 0068 keeps every generator base's dotted stable id out of
`equipmentDefs.ts` on purpose, `resolveItemSprite` can never match it against
any registry `briefId` — every Floor 2 generated-equipment reward rendered as
a text-abbreviation fallback icon, never real art, regardless of whether its
underlying sprite was generated and approved (all 88 bases' art is, in fact,
fully approved and checked in — this was a rendering-bridge gap, not a
missing-art gap).

A concurrent slice fixed the identical gap for the equip/inventory screens
(`EquipmentUI.ts`/`InventoryUI.ts`) by preferring the instance's own
`frozen.artKey` — a `equipment/<stableId path>` string set once at generation
time from the base's art definition — as a literal, preloaded Phaser texture
key. `generated-equipment-icon.ts` is reward-opening presentation
(`src/engine/RewardOpeningUI.ts`'s dedicated call site), squarely inside this
slice's "presentation ... files as needed" ownership, so it was updated to the
same `frozen.artKey`-first contract: try `scene.textures.exists(artKey)` and
render it directly; fall back to the legacy `resolveItemSprite`-via-`baseId`
match (kept for any base predating this convention); fall back to the
two-letter text abbreviation only if neither texture is loaded. This keeps the
reward-opening reveal and the equip screen rendering the same base identically
once real art is preloaded, instead of silently diverging.

### Refinement (2026-07-30): authoring-time pool validation + hardened selection-time fail-closed coverage

A follow-up review pushed back on the rarity-first eligibility filter above
(the correction that replaced provenance-dependent Common stat stripping):
turning a fail-closed illegal-base throw into a rarity-aware _filter_ is only
safe if two things are separately guaranteed, neither of which existed yet as
an explicit, tested invariant:

1. **Authoring validation** — every one of the 88 central-pool bases must be
   legal for _at least one_ achievement rarity/tier, and every tier's eligible
   pool must be non-empty for both affinity sides of both player builds. An
   unknown/misspelled base id must fail loudly, not silently vanish from a
   filter.
2. **Selection-time coverage** — `resolveEquipmentRewardBundle` must keep
   throwing explicitly (never fall back to an empty-but-"valid" selection) if
   rarity-eligibility filtering, once intersected with affinity partitioning,
   leaves either side of a build's pool empty.

**What was proven, and how:**

- `rarityEligibleBaseIds(bases, rarity)` in `floor2-reward-bundle-resolver.ts`
  is now the _single_ source of truth for the Common-exclusion rule (bases
  with an inherent non-armor stat bonus are ineligible for `common`, eligible
  for `uncommon`/`rare`). `resolveEquipmentRewardBundle` and the new authoring
  check both call this one function — there is no second, driftable copy of
  the rule.
- `computeFloor2RewardPoolTierEligibility(bases, weaponIds)` resolves every
  base's affinity (`getGeneratedEquipmentBaseAffinity`, which internally calls
  the same `resolveGeneratedEquipmentBase` the generator itself uses) and
  reports an exact composition — total/weapons/non-weapons/physical-aligned/
  magic-aligned/neutral — per achievement tier × rarity. Because affinity
  resolution throws `GeneratedEquipmentGeneratorError` (`unknown-base`) for any
  id the generator doesn't recognize, an unknown base fails loudly for free,
  with no explicit try/catch needed.
- `validateFloor2RewardPoolTierEligibility()` runs this computation and then,
  for every achievement-reachable `tier × rarity × {physical, magic}` build,
  asserts both the aligned and non-aligned partitions are non-empty — throwing
  a descriptive `Floor2RewardPoolAuthoringError` naming the exact failing
  tier/rarity/affinity/pool-size otherwise. It is invoked unconditionally at
  module load (mirroring the existing `validateRewardPool()` /
  `validateBasicLeatherBases()` eager-validation pattern), so a future content
  edit that breaks the invariant fails the moment the module is imported —
  in CI, in tests, and in the running game alike.
- `resolveEquipmentRewardBundle`'s existing selection-time throws
  (`empty-aligned-pool` / `empty-nonaligned-pool`) were re-examined and left
  as-is: filtering by rarity-eligibility and then partitioning by affinity is
  mathematically identical to partitioning first and filtering second (set
  intersection commutes), so the existing order already satisfied mechanism 2
  literally. The refactor to share `rarityEligibleBaseIds` removed the one real
  risk — a second, hand-maintained copy of the exclusion rule silently
  drifting from the first.

**The `armor`/`accessory` category the request asked to report on does not
exist as a queryable field.** `SlotDefinition` (`equipment-slots.ts`) has no
`category` — only `id`/`label`/`bodyGroup`/`uiPosition`. The only real,
queryable split in this data model is weapon vs. non-weapon (`mainHand`/
`offHand` slot membership vs. everything else). The composition report and
tests therefore report exactly that split, plus derived slot coverage for the
non-weapon side, rather than inventing a category that isn't in the schema.

**Exact numbers, computed from the real 88-base pool (not sampled):**

|                                                         | total | weapons | non-weapons | physical | magic | neutral |
| ------------------------------------------------------- | ----- | ------- | ----------- | -------- | ----- | ------- |
| Common-eligible (tier1/tier2/tier3 `common`)            | 66    | 56      | 10          | 51       | 5     | 10      |
| Uncommon-eligible (tier2/tier3 `uncommon`, = full pool) | 88    | 56      | 32          | 51       | 5     | 32      |

- **0 of 56 weapons are ever excluded from Common.** Weapon variety at Common
  is exactly as broad as the full pool — this is the direct rebuttal to the
  "does this recreate the repeated-four-weapons defect?" concern: it does not,
  because the defect was about weapon variety, and weapon variety is
  unaffected by the Common-exclusion rule (which only ever excludes bases
  carrying an inherent non-armor bonus, and no weapon base in this catalog
  does).
- **22 of 32 non-weapons are excluded from Common** — every one of them an
  "accessory"-style base whose entire design purpose is to carry a stat bonus
  (that is what makes it an accessory rather than plain armor). This is a
  deliberate, by-construction consequence of the Common-exclusion rule, not an
  authoring accident.
- The 10 Common-eligible non-weapons span **12 of the 16 armor slots** (head,
  face, back, shoulders, leftArm, rightArm, leftWrist, rightWrist, chest,
  gloves, legs, feet). The 4 slots with **no** Common-eligible non-weapon
  occupant — **neck, belt, ringLeft, ringRight** — are exactly the slots whose
  only pool occupants are accessory-category bases; every one of them carries
  a bonus by design, so none can ever legally be a Common reward. Tier1
  achievements (Common-only) can therefore never grant a neck/belt/ring
  reward; tier2/tier3 (which can also roll Uncommon) cover them. The
  pool-wide "all 16 armor slots reachable" invariant (enforced by
  `validateRewardPool()` in `floor2-reward-pool.ts`) is a claim about the full
  88-base pool across every rarity, not about the Common-only subset — this
  narrower fact is reported explicitly here rather than glossed over.
- One further, genuinely out-of-scope observation surfaced by this
  computation: only 5 of the pool's 56 weapons are magic-aligned (the rest are
  physical). Both affinity sides remain non-empty at every tier/rarity (magic
  players still get 5 Common-eligible weapon candidates, which is what
  mechanism 2 actually requires), so this does not violate any invariant this
  slice owns — it is a pre-existing weapon-catalog authoring ratio, noted for
  transparency, not something this reward-pool slice's contract requires
  fixing.

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
