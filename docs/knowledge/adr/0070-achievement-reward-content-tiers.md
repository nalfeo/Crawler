# ADR 0070: Achievement Reward Content — Floor 1 Loot Boxes & Floor 2 Tiered Equipment

## Status

Accepted

## Date

2026-07-24

## Estimated Complexity

🍎🍎🍎🍎 — extends the resolved-bundle architecture (ADR 0069) across shared
(catalog/reward tables), core (claim granting), and game (resolver, achievement
defs, carryover) layers; changes the resolved-bundle shape and adds real
claim-time granting for the first time.

## Context

ADR 0069 shipped the resolved-bundle _architecture_ (generate-once-at-unlock,
claim-exactly-once, deterministic RNG isolation, fail-closed carryover) but the
canonical epic plan never defined the actual **reward content**: what Floor 1
boxes contain, how many Floor 2 equipment tiers exist, or what rarity/build-affinity
bias each tier should carry. ADR 0069's bundle was also a fixed 3-item
(Common+Uncommon+Rare) shape — every equipment reward granted all three
rarities at once, which does not support "tiered" rewards where a lower-tier
achievement should only ever be able to grant a Common item.

This slice closes that gap with a concrete, hard-gated content design:

- Floor 1 achievement boxes must contain **only gold + common crafting
  components**, gold scaling with box/achievement rarity, and must **never**
  contain equipment.
- Floor 2 achievements must grant **tiered** equipment: tier1 = common only;
  tier2 = common-or-uncommon; tier3 = uncommon-or-common (no rare — the
  canonical plan does not yet define a higher tier that would unlock Rare
  drops). Higher tiers must have monotonically stronger build-affinity bias
  using the existing Common 25% / Uncommon 50% / Rare 75% contract.
- All of this must reuse the ADR 0069 resolved-bundle APIs unchanged in spirit:
  generation only at resolution (achievement unlock), never at claim/load/
  presentation; exact-once atomic claims; deterministic `SeededRandom`
  isolation from the shared `world.rng` stream.

## Decision

### 1. Replace the fixed 3-item bundle with a single-item, tier-driven bundle

`GeneratedEquipmentRewardBundleV1` gains an `EquipmentRewardTier` (`tier1` |
`tier2` | `tier3`) field. `resolveEquipmentRewardBundle` now takes the tier as
an explicit 4th argument and resolves **exactly one** instance per bundle,
drawn from `EQUIPMENT_REWARD_TIER_RARITIES[tier]`:

| Tier  | Allowed rarities (draw order) | Primary-rarity weight       |
| ----- | ----------------------------- | --------------------------- |
| tier1 | `['common']`                  | 100% common (deterministic) |
| tier2 | `['common', 'uncommon']`      | 75% common / 25% uncommon   |
| tier3 | `['uncommon', 'common']`      | 75% uncommon / 25% common   |

No tier can ever draw `rare` — a future canonical tier (not yet defined) would
be required before Rare equipment could drop from achievements. The weighted
draw is a **separate** `SeededRandom` stream from the existing per-rarity
build-affinity roll (`reward-bundle:v1:<runKey>:<achievementId>:<rarity>:<decision>`
from ADR 0069, unchanged), so tier-rarity selection never contaminates or is
contaminated by the affinity roll.

Build-affinity bias is **still** governed entirely by the existing
`REWARD_BUNDLE_AFFINITY_PROB` contract (Common 25% / Uncommon 50% / Rare 75%)
introduced in ADR 0069 — this slice does not add a separate "tier bonus" roll.
Because tier2 favors drawing `common` (lower affinity-alignment probability)
and tier3 favors drawing `uncommon` (higher alignment probability), the
_effective_ chance a tier's granted item is build-aligned rises monotonically
tier1 < tier2 < tier3 purely as a consequence of which rarity is more likely to
be drawn — satisfying the "monotonically stronger build-affinity bias" gate
without inventing new probabilities.

All ADR 0069 invariants carry over unchanged to the single-item shape:
resolve-before-mutate, scratch-registry transaction + atomic commit,
idempotent re-resolve, zero `world.rng` contamination, and fail-closed
carryover/claim validation — just re-scoped from "exactly 3 canonical-rarity
instances" to "exactly 1 instance whose rarity is a member of the bundle's
tier's allowed pool" and "bundle tier matches the achievement's own defined
tier" (defense in depth against a tampered/stale snapshot re-tiering a bundle).

### 2. Floor 1: `lootBox` reward — resolve-at-unlock, grant-at-claim (gold + common materials only)

Floor 1's `lootBox` achievement reward variant already existed structurally
(carries only a `LootBoxTier`, a **distinct** enum from `EquipmentRewardTier` —
`trash`/`common`/`uncommon`/`rare`/`epic`/`legendary`/`divine` — with no
equipment fields whatsoever, so a Floor 1 box is _structurally_ incapable of
granting equipment) but `claimAchievementReward` treated it as reveal-only. This
slice adds real granting for `lootBox`, mirroring the Floor 2 equipment
resolve/claim split **exactly** (see the reversed Alternative #3 below for why
an earlier claim-time-only design was rejected mid-review):

- **Resolution (unlock time only)** — `resolveLootBoxRewardBundle` (new
  `src/game/lootbox-materials-reward-resolver.ts`) runs from `unlockAchievement`
  the moment a `lootBox` achievement unlocks, symmetric with
  `resolveEquipmentRewardBundle`'s Floor 2 call in the same function. It
  computes gold (`LOOT_BOX_GOLD_BY_TIER`: monotonically increasing 10 / 25 /
  50 / 100 / 200 / 400 / 800 across the 7 `LootBoxTier`s) and draws
  `LOOT_BOX_MATERIAL_COUNT_BY_TIER` materials (1 / 2 / 3 / 4 / 5 / 6 / 8, with
  replacement) from `FLOOR1_COMMON_CRAFTING_MATERIALS` — a catalog-derived list
  of common-rarity crafting components only (no equipment, no rare
  materials) — then freezes the result into a `LootBoxRewardBundleV1` and
  persists it in `world.lootBoxRewardBundles` keyed by `achievementId`,
  idempotently (re-resolving an already-resolved achievement returns the
  existing bundle unchanged, never re-rolls).
- The material roll uses a dedicated `SeededRandom` keyed on
  `lootbox-grant:v1:<runKey>:<achievementId>:materials`, where `runKey` is
  `world.generatedEquipmentRegistry.runKey` — the same stable per-run
  identifier Floor 2's resolver uses, **not** `world.seed` directly and never
  `world.rng` — so replaying the same run always resolves identical materials
  and neither reward path ever contaminates the shared gameplay RNG stream.
  Resolution fails closed (`LootBoxRewardResolutionError`) if the registry has
  no run key configured or the material pool is empty.
- **Claiming (claim time only)** — `claimAchievementReward`'s `lootBox` branch
  performs **zero RNG**: it reads the already-persisted bundle from
  `world.lootBoxRewardBundles`, applies its exact gold + materials in one
  synchronous pass (validated fail-closed beforehand — player entity exists,
  bag exists), then marks claimed and deletes the bundle from the pending map
  — so no partial grant is ever observable and the claim stays exactly-once /
  idempotent (a second claim returns `alreadyClaimed`).

Floor 1's 100 real achievements were already migrated to `lootBox`/
`directorMessage` reward types in a prior session (verified: 0 remaining
`item`/`equipment` reward types on Floor 1) — this slice's job was only to make
the `lootBox` reward actually resolve and grant instead of doing nothing.

### 3. Floor 2: three new tier-driven demo achievements

Added `floor2-field-kit` (tier1, unlocks on first Floor 2 kill),
`floor2-second-wind` (tier2, 10 kills), and `floor2-veteran-cast` (tier3, 30
kills) as the reference tier ladder. These replace the single ADR 0069 demo
achievement that exercised the old fixed 3-item bundle.

### 4. Real production gap found in review: headless AI runner never set a run key

Mid-review, the plan review flagged (and implementation confirmed via a real
crash) that `runHeadless` (`src/game/ai/headless-runner.ts`) built its world
via `createGameWorld({ seed: mergedConfig.seed })` with **no**
`generatedEquipmentRunKey` — unlike `MainGameScene`, which always derives one
via `this.options.generatedEquipmentRunKey ?? generatedEquipmentRunKeyFromSeed(worldSeed)`.
Once Floor 1 achievements resolve-at-unlock (this slice) instead of doing
nothing, any headless AI run (sweeps, `check-size-coverage`, weapon sweeps,
`ai:headless`) that unlocked a `lootBox` achievement crashed with
`LootBoxRewardResolutionError: registry has no run key`. This was a
**pre-existing** gap in the headless runner (Floor 2 equipment rewards had the
same latent exposure, just never exercised because no headless scenario had
unlocked a Floor 2 tiered achievement before now) — fixed by making
`runHeadless` derive `generatedEquipmentRunKeyFromSeed(mergedConfig.seed)` the
same way `MainGameScene` does, so headless and interactive play now share
identical resolved-bundle behavior.

## Consequences

### Positive

- Floor 1 is now structurally incapable of granting equipment (the `lootBox`
  reward variant has no equipment fields at all), satisfying the hard gate
  without relying on a runtime check that could regress.
- Floor 2's tier ladder gives a stable, extensible contract: a future tier4+
  can be added by extending `EQUIPMENT_REWARD_TIERS` and
  `EQUIPMENT_REWARD_TIER_RARITIES` without touching the resolver's core logic.
- Single-item bundles are simpler to validate and claim than the old 3-item
  shape, and the tier-vs-achievement cross-check adds defense-in-depth against
  a tampered snapshot silently re-tiering a reward.
- All new tests (unit resolver, property affinity/determinism, integration
  claim) exercise the real production APIs end-to-end — no fixture reimplements
  the resolver contract.

### Negative / Risks

- Existing persisted saves from before this slice used the ADR 0069 fixed
  3-item bundle shape with no `tier` field; `restorePlayerCarryover` now
  fail-closed rejects any bundle missing a valid tier or holding other than
  exactly 1 instance. This is an intentional breaking change to the bundle
  schema, now explicitly version-bumped to
  `floor2-equipment-reward-bundle/v2`, so pre-slice `v1` snapshots are
  intentionally rejected by schema-version validation — acceptable here
  because the game has no shipped saves yet.
- `LOOT_BOX_GOLD_BY_TIER` / `LOOT_BOX_MATERIAL_COUNT_BY_TIER` numeric tables are
  a first-pass balance guess (not yet play-tested); tuning is expected as a
  follow-up and does not require an ADR (data-only change).

### Accepted risk (security review, out of scope)

A dedicated security review pass surfaced two pre-existing save-tampering
concerns, both judged **out of scope** for this slice and accepted as risk
rather than fixed:

1. **`claimedAchievementIds` removal replay** — a hand-edited save that strips
   an achievement id out of the claimed-ids set (while leaving the resolved
   bundle in place) could re-claim a reward. This is symmetric with ADR 0069's
   existing exposure for equipment bundles and is not made worse by this
   slice.
2. **Equipment bundle forgery via fingerprint bypass** — a save editor with
   knowledge of the bundle schema could hand-craft a `tier`/rarity combination
   that the client-side validator accepts as internally consistent.

Both require local save-file tampering (no network/multiplayer trust
boundary is crossed) and match the game's existing security posture for
client-authoritative saves generally — building anti-cheat/save-integrity
infrastructure (signing, server-side validation) is a separate, larger
initiative and not warranted for this slice. Revisit if/when the game adds a
server-trusted save path.

### Accepted risk (round-2 multi-model review, out of scope)

A second review round (parallel code-review + two multi-model reviews) surfaced
two further legacy-compatibility findings, both judged **out of scope** for
this slice and accepted as risk (documented, not fixed) rather than building
backward-compat migration code — building a load/claim-time migration path
would itself violate this slice's own hard gate ("generation only at
resolution, never claim/load/presentation"):

1. **Equipment bundle schema-shape break, now an honest failure.** This slice
   bumps `GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION` from
   `floor2-equipment-reward-bundle/v1` to `/v2` specifically so that any
   pre-existing (same-session, pre-merge) 3-instance/no-`tier` bundle now fails
   fast with an explicit "unsupported version" error at the very first
   per-bundle check, instead of falling through to a confusing
   instance-count/tier-missing structural error deeper in validation. No
   shipped save ever held a `/v1` bundle (this repo has no release yet), so
   the bump is a zero-risk, message-clarity-only change — not a real data
   migration.
2. **Legacy unlocked-but-unclaimed `lootBox` achievements become permanently
   unclaimable.** Before this slice, `lootBox`-reward achievements were
   reveal-only (no resolved bundle was ever created at unlock). The new
   fail-closed reverse-check in `validateLootBoxRewardBundles` requires every
   unlocked+unclaimed `lootBox` achievement to have a matching persisted
   bundle; a save carrying such an achievement from before this slice merged
   would now fail to restore. As with (1), this only affects same-session,
   pre-release saves and there is no live player base to protect. If a real
   backfill is ever needed, it must happen entirely within `unlockAchievement`
   (the one true resolution point), never as a load-time or claim-time
   migration shim.

Both are consistent with round 1's precedent (documented, not fixed) and with
the game's current no-shipped-saves, solo-dev, pre-release posture — revisit
if/when saves must survive across a public release boundary.

### Fixed regression (round-3 confirmation review)

A third confirmation round (three reviewers on the full branch diff) found a
genuine, high-severity regression: the new Floor 1 `lootBox` branch in
`unlockAchievement` (`src/game/systems/achievementSystem.ts`) called
`resolveLootBoxRewardBundle` unconditionally, and that resolver throws
`LootBoxRewardResolutionError('no-run-key', ...)` (re-thrown, not swallowed)
whenever `world.generatedEquipmentRegistry.runKey === null`. Real gameplay
entry points (`MainGameScene`, `headless-runner`) always derive a run key
from the world seed, so this was invisible there — but any world built via
`createGameWorld({ seed })` directly with no explicit
`generatedEquipmentRunKey` (a common, legitimate configuration for many
ECS/headless tests unrelated to rewards) now crashed the instant it reached a
trivially-easy Floor 1 achievement like `quest-accepted`. This broke 2
pre-existing integration test files outright and was a latent landmine for
several more (headless spawner tests) that happened not to trigger it.

**Fix**: the `lootBox` branch now checks `world.generatedEquipmentRegistry.runKey
=== null` and returns `false` (fails closed, no unlock, no throw) _before_
calling the resolver — mirroring the equipment branch's existing pattern of
gating on feature availability
(`getFloor2EquipmentRewardsAccess(world).kind !== 'enabled'`) before ever
invoking its resolver. The resolver itself is unchanged and still throws on a
direct call with no run key (a defense-in-depth invariant, still covered by
`tests/unit/lootbox-materials-reward-resolver.test.ts`) — only the achievement
unlock call site now pre-checks.

This is a **systemic** fix, not a per-test-file patch: it makes "no run key
configured" a legitimate, silent "rewards unavailable for this world" state
for the lootBox path, matching how the equipment path already treats its own
unavailability conditions, rather than requiring every future test/lab world
that might unlock a Floor 1 achievement to remember to configure a run key.
Full `--project integration` (24 files/187 tests) and `--project headless`
(24 files/148 tests) suites were re-run in full (not just changed-file
selection) after the fix to confirm no other landmine of this shape remained.

A follow-up (round-4) confirmation review then found the identical latent
shape already present in the equipment branch: `getFloor2EquipmentRewardsAccess`
gates on floor + feature flags but never checks the run key itself, so a world
with those flags flipped true and no run key would hit the same uncaught
`RewardBundleResolutionError('no-run-key', ...)` throw. No current call site
combines "flags enabled" with "no run key" today, so this wasn't an active
regression, but it is the exact same bug shape directly adjacent in the same
function this slice modified — fixed with the identical pre-check pattern.
Direct regression tests for both branches (`unlockAchievement` returns `false`
without throwing, and does not record an unlock or a bundle, when the run key
is null) were added to `tests/game/achievement-system.test.ts`.

**Systemic recommendation (not implemented in this slice)**: `createGameWorld`
(`src/core/world.ts`) has no default run key, unlike the test helper
`createTestWorld` (`tests/helpers/world-factory.ts`), which already derives one
from the seed by default. Consider giving `createGameWorld` the same default in
a future slice to prevent this landmine shape from recurring for other
resolver call sites; out of scope here since it is a broader architectural
change beyond this slice's reward-content boundary.

### Deviation note (historical, superseded by amendment below)

At the time this ADR was first written, the canonical epic plan had no tier4+,
so `EQUIPMENT_REWARD_TIER_RARITIES` intentionally contained no Rare-capable
tier. That deferment is superseded by the 2026-07-31 amendment below.

### Amendment (2026-07-31): shared `tier4` across boss chests and brutal achievements

After the Floor 2 achievement-content merge and subsequent review-fix recovery,
we reconciled a cross-PR `tier4` collision with the already-landed boss-chest
85%/15% Uncommon/Rare split: both lines of work needed `tier4`, and keeping
achievement rewards excluded from it would have made the three `brutal`
achievement rewards fail schema validation.

Escalated to the human per rule #11 (never silently reinterpret an established
contract); resolution: **`tier4` is one shared Rare-capable tier, used by both
boss chests and `brutal`-difficulty achievements**, at the boss-chest PR's
85%/15% Uncommon/Rare split (`EQUIPMENT_REWARD_TIER_RARITIES.tier4 =
['uncommon', 'rare']`, weight `0.85` for the primary/uncommon draw — order and
weight adopted from the boss-chest design since it landed second and its
weight table was already in place). Consequences:

- `ACHIEVEMENT_EQUIPMENT_REWARD_TIERS` / `AchievementEquipmentRewardTier` are
  now plain aliases of the full `EQUIPMENT_REWARD_TIERS` set (`tier1`-`tier4`),
  not a narrower 3-tier exclusion — the achievement Zod schema now accepts
  `tier4` achievements directly.
- `tier4` remains restricted in authored achievement content to the three
  `difficulty: 'brutal'` entries (`floor2-family-annihilator`,
  `floor2-floor-cleared`, `floor2-scorched-earth`). Their mastery bars are
  intentionally high but not identical: annihilator requires defeating 3+
  family bosses, scorched-earth requires engaging every present family in
  combat, and floor-cleared requires completing the leave-floor objective/run
  clear.
- No behavioral difference for boss chests: they always drew from
  `EQUIPMENT_REWARD_TIER_RARITIES.tier4` regardless of which side "owns" the
  tier name: the tier is a rarity-pool lookup, not a chest/achievement type
  discriminator, so there is no code path anywhere that branches on "is this
  tier4 draw a boss chest or an achievement" — sharing the tier introduces no
  new coupling.
- This reconciles cleanly with the boss-chest PR's own design note (the
  85/15 split its ADR/PR description establishes); no further changes were
  needed there beyond widening the achievement-side enum.

### Amendment (2026-07-30): `common`/`uncommon`/`rare` player-facing vocabulary; `tier4` retracted from achievement JSON; full 36-achievement catalog

The `floor2-inventory-reward-pool` slice required the human's exact
player-facing tier vocabulary — `common`/`uncommon`/`rare`, mapped from the
internal `tier1`/`tier2`/`tier3` — for **every** Floor 2 achievement reward,
and explicitly forbade `tier4` from ever appearing in achievement JSON again.
This **reverses** the 2026-07-31 amendment above, which had made `tier4` a
shared Rare-capable tier available to both boss chests and the three
`brutal`-difficulty achievements. Escalating a second time was unnecessary —
the human's own task instructions were the decision this time, not a
cross-session collision — but the reversal is significant enough to record
explicitly rather than silently re-editing the prior amendment's prose away:

1. **Vocabulary.** `src/shared/achievements.ts` now defines
   `FLOOR2_ACHIEVEMENT_LOOT_TIERS = ['common', 'uncommon', 'rare']` (a
   `Floor2AchievementLootTier`) as the only tier vocabulary that may appear in
   `achievements.floor2.json`, with a one-way
   `FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER` map
   (`common → tier1`, `uncommon → tier2`, `rare → tier3`) applied exactly once,
   at each achievement-reward call site, before invoking
   `resolveEquipmentRewardBundle`/`claimGeneratedEquipmentRewardBundle`. The
   resolver's own `tier1`-`tier4` keyspace, `EQUIPMENT_REWARD_TIER_RARITIES`
   pools, and the boss-chest 85%/15% Uncommon/Rare `tier4` split are all
   **unchanged** — only a translation layer was added above them.
2. **`tier4` is boss-chest-exclusive again.** The three `brutal`-difficulty
   achievements (`floor2-family-annihilator`, `floor2-floor-cleared`,
   `floor2-scorched-earth`) now carry the player-facing `rare` tier, which
   maps to internal `tier3` — **not** `tier4`. This is a real, intentional
   capability reduction versus the reversed amendment: `tier3`'s allowed
   rarity pool (`['uncommon', 'common']`, 75%/25%) contains **no** `rare`
   draw, so these three achievements can no longer mechanically produce a
   true Rare-rarity generated-equipment instance, despite being labeled
   `rare` in content and being the hardest-to-earn Floor 2 achievements. This
   was a known, accepted consequence of the human's explicit instruction
   ("tier4 remains boss-chest-only... never in achievement JSON") — not
   relaxed, not silently reinterpreted, and flagged back to the human rather
   than fixed unilaterally, per rule #2 (never weaken an explicit requirement
   to make something pass) and rule #11 (escalate, don't silently
   reinterpret). If a genuine Rare-capable achievement tier is wanted in the
   future, it needs its own named tier and its own human decision — reusing
   `tier4` is explicitly off the table now.
3. **Full production catalog, not a 3-achievement reference ladder.** All 36
   real Floor 2 achievements in `achievements.floor2.json` now carry a
   `lootBox`/`floor2-generated-equipment` reward with a
   `Floor2AchievementLootTier`, replacing the `floor2-field-kit` /
   `floor2-second-wind` / `floor2-veteran-cast` 3-achievement demo ladder this
   ADR originally introduced (those three IDs are retained as real content
   achievements within the full 36, still exercising `tier1`/`tier2`/`tier3`
   respectively). Distribution: 13 `common` / 12 `uncommon` / 11 `rare`. One
   deliberate promotion: `floor2-safe-harbor` moved from `common` to `rare`
   during migration (a considered content decision to keep the tier
   distribution close to even, not an oversight) — this is a definitional
   change to that specific achievement's reward, not a mechanical side effect,
   and is called out here since no other individual achievement's originally
   authored tier was altered.
4. **Central reward pool feeds every achievement uniformly.** See the ADR
   0069 amendment for the 88-base central pool
   (`src/shared/data/floor2-reward-pool.ts`) that all 36 achievements now draw
   from via `resolveEquipmentRewardBundle`, replacing what would otherwise
   have been 36 hand-authored per-achievement base lists.
5. **18 new Classic Fantasy Basic Leather bases.** Sourced from
   `data/theme-equipment-sets/classic-fantasy-basic-leather.json`; authored
   as 6 weapons + 12 non-weapons (`src/shared/data/floor2-basic-leather-bases.ts`)
   at conservative Common baselines using the nearest existing weapon/slot
   profile, covering all 16 armor slots between the new and pre-existing
   bases combined. These consume the 18 art concepts already checked into
   `src/shared/data/floor2-equipment-art.ts` (88-entry manifest total: 70
   pre-existing + 18 new). Per ADR 0068 (unchanged, re-confirmed, not
   touched): the 6 Basic Leather weapons register only in `weaponDefs.ts`'s
   generator-only weapon-base map, and none of the 18 Basic Leather bases
   (weapon or non-weapon) were added to `equipmentDefs.ts` —
   `resolveGeneratedEquipmentBase` remains the sole bridge, verified directly
   by a dedicated test asserting all 18 stable IDs are absent from
   `getEquippableItemIds()`.

## Alternatives Considered

1. **Keep the fixed 3-item bundle and gate "tier" by which rarities are
   present/absent** — rejected: this conflates "tier" with "bundle contents"
   and would require every claim to filter which of the 3 instances actually
   count, re-introducing the variable-size-bundle design ADR 0069 already
   rejected via adversarial review.
2. **A single shared rarity-weight table with a "tier multiplier" applied on
   top of `REWARD_BUNDLE_AFFINITY_PROB`** — rejected: the hard gate's
   "Common 25% / Uncommon 50% / Rare 75%" contract is explicitly canonical and
   must not be reinterpreted per-tier; monotonic bias is achieved for free by
   which rarity a tier is more likely to draw, so no second probability axis is
   needed.
3. **Grant Floor 1 lootBox rewards at unlock time (mirroring Floor 2
   equipment fully, including the mutation)** — initially adopted in an early
   draft of this slice, then **rejected during plan review**, then
   **re-adopted in revised form**: the review correctly flagged that the
   original implementation rolled Floor 1 materials at **claim** time keyed
   on `world.seed`, which both used the wrong entropy source (not the stable
   `runKey`) and — more fundamentally — violated the hard gate "generation
   only at resolution, never at claim/load/presentation." The fix is **not**
   to grant gold/materials at unlock (that would let an unclaimed achievement
   silently deposit rewards, breaking claim's exactly-once/player-initiated
   contract) but to split resolution from granting exactly as Floor 2 already
   does: `resolveLootBoxRewardBundle` computes and persists the immutable
   bundle at unlock (resolution), while `claimAchievementReward` only reads
   and applies that pre-resolved bundle at claim (granting) — zero RNG at
   claim time, matching Floor 2's `resolveEquipmentRewardBundle` /
   `claimGeneratedEquipmentRewardBundle` split precisely. This is the design
   actually shipped; see Decision §2.

### Amendment (2026-07-31): generated non-armor power is affix-driven

Floor 2 generated equipment now derives non-armor power from rarity-driven
affixes instead of inheriting non-armor base stat bonuses. Tier rarity behavior
from this ADR is unchanged; the amendment narrows where non-armor power enters
the generated instance.
