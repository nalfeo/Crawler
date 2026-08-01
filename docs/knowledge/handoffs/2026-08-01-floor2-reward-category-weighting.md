# Floor 2 reward category weighting (25% weapon / 75% non-weapon)

**Date:** 2026-08-01
**Session slug:** floor2-reward-category-weighting
**Apple estimate:** 3🍎 (actual: 3🍎)
**PR:** closes #2555

## Systems touched

floor2-rewards, achievement-system

## Problem addressed

Floor 2 reward draws were 64% weapons vs 36% non-weapons in a pool with only 2
weapon slots vs 16 armor/accessory slots — a 14× per-slot oversupply of weapons.
After the first 1–2 weapon draws, additional weapon rewards could never expand
equipment coverage and felt valueless. Issue #2555.

## Solution

Added **category weighting** to the reward draw (Option 2 from the issue):
sample weapon-vs-non-weapon at an authored ratio first, then pick within the
chosen sub-pool using the existing affinity-alignment logic (weapon draws) or
uniform draw (non-weapon draws, which are all neutral affinity).

Weapon category weight: **`FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT = 0.25`** (25%).
Non-weapon weight: 75%.

Full kit remains hard — this removes dead draws (3rd+ weapon) but doesn't
guarantee completion.

## Key design decisions

1. **Version NOT bumped**: The category draw uses a new substream key
   (`reward-bundle:v1:<runKey>:<achId>:category:<tier>`) that never existed in
   v1. No existing bundle will re-roll because `resolveEquipmentRewardBundle` is
   idempotent — it returns unchanged for already-resolved achievements.
   Bumping to v2 would have re-drawn every boss-chest reward unnecessarily.

2. **Non-weapon draws skip affinity alignment**: ALL non-weapon bases carry
   `neutral` affinity. Applying `partitionBases` would always produce
   `aligned = []` and crash with `empty-aligned-pool`. Non-weapon draws are
   uniform over the eligible non-weapon pool.

3. **Opt-in via `weaponIds` param**: `resolveEquipmentRewardBundle` takes an
   optional 5th param `weaponIds?: ReadonlySet<string>`. When omitted (boss
   chest path, `boss-chest-resolver.ts`), the original affinity-only algorithm
   runs unchanged. Only `achievementSystem.ts` passes `FLOOR2_REWARD_WEAPON_ID_SET`.

4. **Authoring validator extended**: `_validateFloor2RewardPoolTierEligibility`
   now checks the weapon sub-pool (both affinities reachable) and non-weapon
   sub-pool (at least one eligible candidate per tier × rarity), and asserts all
   non-weapon bases are neutral. The "weaponIds non-empty but ∩ bases = ∅" guard
   catches a future authoring bug where the weaponId set drifts from the pool.

## Files changed

| File | Change |
| --- | --- |
| `src/game/floor2-reward-bundle-resolver.ts` | Added `FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT`, `REWARD_BUNDLE_RESOLVER_VERSION`, `_categoryFromRoll`, extended `resolveEquipmentRewardBundle` (5th param), extended `_validateFloor2RewardPoolTierEligibility` |
| `src/game/systems/achievementSystem.ts` | Import `FLOOR2_REWARD_POOL_WEAPON_IDS`, define `FLOOR2_REWARD_WEAPON_ID_SET`, pass as 5th arg |
| `tests/unit/floor2-reward-bundle-resolver.test.ts` | Added tests: exact threshold contract, empirical frequency, integration (purity + determinism), validator sub-pool error paths |
| `docs/knowledge/review-ledgers/2026-08-01-floor2-reward-category-weighting.review-ledger.json` | 3🍎 review ledger, plan+code review complete |

## Review harness

3🍎 tier — plan review + code review loop.
- Plan review: `gpt-5.4`, 4 concerns, 4 resolved, `plan_divergence: minor`
- Code review: `claude-sonnet-4.6`, round 1 clean, 3 concerns all resolved

## Potential follow-on

- Issue #2552 (magic-vs-physical acquisition asymmetry) shares the same remedy
  direction; the category-weighted non-weapon path already draws uniformly over
  the neutral pool — no affinity bias. If #2552 needs further tuning, the
  `_categoryFromRoll` helper and `weaponIds` opt-in pattern are the hooks to build on.
- Issue #2551 (level-10 arrival verification) defines the measurement gate for
  fill-rate target; once that number is set, validate with a headless AI sweep.
