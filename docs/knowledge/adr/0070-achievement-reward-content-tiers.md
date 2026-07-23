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

### 2. Floor 1: real `lootBox` claim-time granting (gold + common materials only)

Floor 1's `lootBox` achievement reward variant already existed structurally
(carries only a `LootBoxTier`, a **distinct** enum from `EquipmentRewardTier` —
`trash`/`common`/`uncommon`/`rare`/`epic`/`legendary`/`divine` — with no
equipment fields whatsoever, so a Floor 1 box is _structurally_ incapable of
granting equipment) but `claimAchievementReward` treated it as reveal-only. This
slice adds real granting for `lootBox`, claim-time only:

- `LOOT_BOX_GOLD_BY_TIER`: monotonically increasing gold table (10 / 25 / 50 /
  100 / 200 / 400 / 800 across the 7 `LootBoxTier`s), granted directly to
  `world.playerGold`.
- `LOOT_BOX_MATERIAL_COUNT_BY_TIER`: monotonically increasing material-count
  table (1 / 2 / 3 / 4 / 5 / 6 / 8), each slot drawn (with replacement) from
  `FLOOR1_COMMON_CRAFTING_MATERIALS` — a catalog-derived list of common-rarity
  crafting components only (no equipment, no rare materials).
- Materials are drawn from a dedicated `SeededRandom` keyed on
  `lootbox-grant:v1:<world.seed>:<achievementId>:materials` — never
  `world.rng` — so replaying the same run seed + achievement always grants
  identical materials and claiming a box never contaminates the gameplay RNG
  stream (mirrors the ADR 0069 affinity-roll isolation pattern).
- Grants are validated fail-closed **before** any mutation (player entity
  exists, bag exists, material pool non-empty); gold + materials are then
  applied synchronously in one pass, followed by marking claimed — so no
  partial grant is ever observable and the claim stays exactly-once /
  idempotent (a second claim returns `alreadyClaimed`).

Floor 1's 100 real achievements were already migrated to `lootBox`/
`directorMessage` reward types in a prior session (verified: 0 remaining
`item`/`equipment` reward types on Floor 1) — this slice's job was only to make
the `lootBox` claim path actually grant instead of reveal-only.

### 3. Floor 2: three new tier-driven demo achievements

Added `floor2-field-kit` (tier1, unlocks on first Floor 2 kill),
`floor2-second-wind` (tier2, 10 kills), and `floor2-veteran-cast` (tier3, 30
kills) as the reference tier ladder. These replace the single ADR 0069 demo
achievement that exercised the old fixed 3-item bundle.

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
  schema (still versioned `V1`; a real migration would need a `V2` schema
  bump) — acceptable here because the game has no shipped saves yet.
- `LOOT_BOX_GOLD_BY_TIER` / `LOOT_BOX_MATERIAL_COUNT_BY_TIER` numeric tables are
  a first-pass balance guess (not yet play-tested); tuning is expected as a
  follow-up and does not require an ADR (data-only change).

### Deviation note

The user's request described "rare unless canonical plan explicitly defines a
higher tier" — the canonical epic plan does not currently define a tier4+, so
`EQUIPMENT_REWARD_TIER_RARITIES` intentionally has **no** tier whose pool
includes `rare`. Adding a Rare-capable tier is deferred to a future slice.

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
   equipment)** — rejected: the hard gate requires generation only at
   resolution and grants only at claim; unlocking a Floor 1 achievement without
   claiming it must not silently deposit gold/materials, since claim is the
   player-facing "open the box" action and must remain exactly-once and
   player-initiated.
