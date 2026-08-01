# Session Handoff: Magic Build Reward Parity — Floor 2 Non-Aligned Pool Fix

## Date

2026-08-01

## Persona

Game Designer (balance fix)

## Systems touched

equipment-rewards, floor2-content

## Apples

3🍎 estimated, 2🍎 actual (📈 over — issue was surgical once root cause was confirmed; no new content needed)

## What Was Done

Fixed magic build gear acquisition parity for Floor 2 rewards (issue #2552).

**Root cause confirmed:** The 88-base Floor 2 reward pool has 56 weapons (51 physical, 5 magic) and 32 neutral non-weapons. The reward resolver's non-aligned draw bucket for magic players contained all 83 non-magic items (51 physical weapons + 32 neutrals) — 61% were unusable physical weapons. Physical players only had 37 non-aligned candidates (5 magic + 32 neutrals), mostly useful neutral wearables. Magic builds were estimated to fill ~7-8 of 18 equipment positions by level 10 vs ~10-12 for physical builds.

**Fix applied:** Modified `_partitionBases()` in `src/game/floor2-reward-bundle-resolver.ts` to prefer neutral (non-weapon) bases for non-aligned reward draws when neutrals are present. Off-affinity weapons are excluded from the non-aligned pool; they only appear via the fallback when no neutrals exist (preserving backward compatibility with weapon-only test fixtures and boss-chest pools).

Both builds now draw from the same 32-item neutral wearable pool on non-aligned draws — symmetric by construction.

**Tests updated/added** in `tests/unit/floor2-reward-bundle-resolver.test.ts`:
- Updated three-way affinity test: asserts off-affinity weapon never appears as a non-aligned draw
- Added `_partitionBases — neutral-preference logic` describe block: 4 deterministic unit tests covering neutral-preference, fallback, full 88-item pool symmetry, and equal pool size for both builds
- Updated exhaustive coverage test and real-pool test to use `_partitionBases` (exported for unit testing)

**Validation:** Deterministic unit tests confirm both builds get exactly 32 neutral wearables as their non-aligned pool on the full reward pool. This is the exact proxy metric for the pool-asymmetry root cause. CI runs headless and unit tests on push.

## Key Decisions Made

**Chose option 2 (neutral-preference) over option 1 (expand magic weapons) or option 3 (slot-need weighting):**
- Option 1 requires authoring new magic weapon content (significant new work, art placeholders, balance tuning)
- Option 3 requires tracking player slot state during reward resolution (more complex, larger change surface)
- Option 2 is a single function change, no new content, deterministic, and approximately symmetric

**Hard exclusion over weighted preference:** A weighted preference (e.g., 80% neutral / 20% off-affinity) would preserve some variety but requires tuning and is less cleanly symmetric. The issue explicitly called out off-affinity weapons as the problem — fully excluding them from non-aligned draws is the correct intent. Acknowledged tradeoff: no off-affinity weapon "surprise" drops in non-aligned slots. These weapons remain accessible via aligned draws for the matching affinity.

**Boss-chest pools remain weapon-only:** The fix has no effect on `boss-chest-resolver.ts` boss-chest pools (a separate disjoint set of bases). This is correct — boss-chest weapon draws are intentional. The scope is achievement reward parity only.

**Exported as `_partitionBases` for unit testing:** The prefix convention avoids polluting the public API surface while enabling direct partitioning-contract tests.

## What's Next / Blockers

- **Follow-up: headless acquisition measurement** — A future session could add a headless regression that measures filled equipment slot counts by level 10 across many seeds for both physical and magic builds, asserting the gap is within a target tolerance. This was raised in plan review as the ground-truth validation; the current deterministic pool-composition tests are a correct proxy but don't observe actual gameplay draws.
- **Follow-up: authoring guard** — Consider adding a test that asserts the main Floor 2 achievement pool always contains neutral items (so the fallback-only path is never accidentally activated on a production pool by a future content change).
- No blockers for this PR. CI owns the full suite.

## Retrospective

### Lessons Learned

- The affinity classification lives in `getGeneratedEquipmentBaseAffinity()` (generated-equipment-generator.ts) and returns 'magic' only for `WeaponType.MAGIC`. BEAM and TRAP weapon types are 'physical'. Only the 5 `magic-focus` family weapons in the art manifest are MAGIC type. This is the authoritative classification — don't infer from weapon name.
- The pool hard-validates sizes at module load time (`_validateFloor2RewardPoolTierEligibility`). If the partition produces an empty non-aligned pool, it throws at startup. The fallback in `_partitionBases` prevents this for weapon-only fixtures, but the real pool always has 32 neutrals.
- No node_modules in the sandbox — `npm run verify:fast`, `npm run review:ledger`, etc. cannot run locally. CI is the only execution environment. Plan for this from the start and don't waste time retrying npm commands.

### Mistakes Made

- Initially tried to run `npm run verify:fast` repeatedly before confirming node_modules were absent. A quick `ls node_modules` at session start would have saved time.

### Opportunities for Future Improvement

- A headless simulation test measuring filled equipment positions by level 10 per build affinity would be a much stronger parity gate than pool-composition tests. Worth a dedicated 3-4🍎 session once Floor 2 headless runner exists.
- The 51:5 physical-to-magic weapon imbalance in the pool is a root-cause gap; direction 1 (expanding the magic weapon roster) would be the permanent fix. The neutral-preference fix is the correct minimal intervention now but doesn't address the underlying content asymmetry.
