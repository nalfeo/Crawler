# Achievement reward-content slice (Floor 1 loot boxes, Floor 2 tiered equipment)

## Systems touched

quests, inventory, ci-policy

## Summary

Implemented and landed the achievement **reward-content** slice on top of the
merged resolved-bundle architecture (PR #1810, squash `9be0328ec`). Prior to
this slice, `claimAchievementReward` was reveal-only: achievements unlocked
but granted nothing.

- **Floor 1 achievements** now grant a `lootBox` reward: gold (scaled by
  tier) + a fixed count of **common crafting materials only** — never
  equipment. Generation happens once, at unlock time, via a new dedicated
  resolver `src/game/floor1-lootbox-reward-resolver.ts`, storing an immutable
  `LootBoxRewardBundleV1` in `world.lootBoxRewardBundles`. Claim only reads
  and grants the already-resolved bundle (never regenerates).
- **Floor 2 achievements** now grant tiered `equipment` rewards reusing the
  merged Floor 2 equipment resolver/registry: tier1 = common only, tier2 =
  common-or-uncommon, tier3 = uncommon-or-common (no rare — the canonical
  plan defines no tier4+ yet). Each tier has a monotonically increasing
  build-affinity bias reusing the existing canonical contract (Common 25% /
  Uncommon 50% / Rare 75%, where applicable to the tier's pool).
- RNG isolation: Floor 1 lootBox materials are drawn from a `runKey`-derived
  SeededRandom substream keyed by achievement id, isolated from both the
  world's general RNG and the Floor 2 equipment resolver's own substreams —
  proven by dedicated cross-resolver isolation tests.
- Exact-once/idempotent atomic claims preserved: capacity for **all** grants
  (gold + materials, or the equipment instance) is validated before any state
  mutation, so a mid-claim failure (e.g. full bag) leaves nothing partially
  granted.
- Persisted-bundle save/load carryover extended to lootBox bundles, with
  fail-closed validation (forged bundles, forged live-claim values, and
  missing-bundle-for-unlocked-achievement are all rejected) mirroring the
  equipment path's existing guards.

## Files touched (representative, not exhaustive — see `git diff main...HEAD`)

- `src/game/floor1-lootbox-reward-resolver.ts` (new) — Floor 1 lootBox bundle
  resolver.
- `src/game/systems/achievementSystem.ts` — `unlockAchievement` now resolves
  the reward bundle (lootBox or equipment) at unlock time, atomically, with
  fail-closed pre-checks for both branches (see regression note below).
- `src/game/achievementRewards.ts`, `src/game/playerCarryover.ts` — claim path
  - save/load carryover validation for both reward types.
- `src/shared/achievements.ts` — tier constants
  (`LOOT_BOX_GOLD_BY_TIER`, `LOOT_BOX_MATERIAL_COUNT_BY_TIER`,
  `FLOOR1_COMMON_CRAFTING_MATERIALS`, `EQUIPMENT_REWARD_TIER_RARITIES`), schema
  version bump `floor2-equipment-reward-bundle/v1` → `/v2`.
- `src/labs/achievements-ui-lab.ts` (rewritten) — exercises both reward types.
- Tests: `tests/unit/floor1-lootbox-reward-resolver.test.ts` (new),
  `tests/integration/floor2-reward-bundle-claim.integration.test.ts` (extended
  — 39 tests), `tests/game/achievement-system.test.ts` (extended — 12 tests).
- `docs/knowledge/adr/0070-achievement-reward-content-tiers.md` (new ADR).
- `docs/knowledge/review-ledgers/2026-07-23-achievement-reward-content.review-ledger.json`
  (new ledger — plan_review 1 round, code_review 4 rounds, multi_model_review
  3 rounds; validates as a 4🍎 ledger).
- `docs/knowledge/metrics/apples/2026-07-23-achievement-reward-content.json`
  — 4🍎 estimated, 5🍎 actual (delta +1, under cap) — the extra apple reflects
  the round-3/4 regression discovery-and-fix described below.

## Review harness summary (4🍎 — plan review + code-review loop + multi-model review + adjudication, all required)

- **Plan review (adversarial)**: 1 rejection — initial plan generated Floor 1
  lootBox materials inline at claim-time from `world.seed`, violating
  "generation only at resolution" and floor-isolation entropy hygiene. Fixed
  by adding the dedicated resolver before any implementation continued.
- **Code review**: 4 rounds. Round 1 (3 concerns: claim-atomicity gold-before-
  materials ordering, an optional `tier?` field, 2 pre-existing
  out-of-scope save-tampering concerns documented in the ADR). Round 2 (8
  concerns across 2 sub-rounds: canonical count re-validation at carryover
  restore, bidirectional bundle-presence reverse-guards for both reward
  types, an achievements-ui-lab rewrite, a fail-open `?? []` default bug, a
  schema version bump, and a converged Major finding — the equipment
  reverse-guard was unreachable through `validateGeneratedCarryover`'s
  early-return path; extracted `validateEquipmentBundlePresence` to run
  unconditionally). Round 3 found a **genuine post-round-2 regression**
  (below). Round 4 confirmed the round-3 fix and found one more instance of
  the same bug shape plus a test-coverage gap, both fixed; round 4 is clean.
- **Multi-model review**: 3 rounds (opus + gemini), converged on the same
  findings code-review caught in rounds 1–2, independently CLEAN in round 3
  on the full diff (though it did not itself catch the round-3 regression
  found by the parallel code-review pass that round — recorded honestly in
  the ledger).
- Ledger validated: `npm run review:ledger -- validate
docs/knowledge/review-ledgers/2026-07-23-achievement-reward-content.review-ledger.json`
  → passes.

## Regression found and fixed in final confirmation (important — read if touching `achievementSystem.ts` again)

A round-3 confirmation reviewer found that the new Floor 1 `lootBox` branch
in `unlockAchievement` called `resolveLootBoxRewardBundle` **unconditionally**,
which throws `LootBoxRewardResolutionError('no-run-key', ...)` (re-thrown, not
swallowed) whenever `world.generatedEquipmentRegistry.runKey === null`. Real
gameplay entry points (`MainGameScene`, `headless-runner`) always derive a run
key from the seed, so this was invisible there — but any world built via
`createGameWorld({ seed })` directly with **no** explicit
`generatedEquipmentRunKey` (a common, legitimate configuration for many
ECS/headless tests unrelated to rewards — `createTestWorld` in
`tests/helpers/world-factory.ts` already defaults this, but raw
`createGameWorld` does not) crashed the instant it reached a trivially-easy
Floor 1 achievement like `quest-accepted`. This broke 2 pre-existing
integration test files outright (`floor1-spawners-pipeline.test.ts`,
`fireball-pulse-shield-integration.test.ts`) and was **not caught by
`verify:fast`**, which only runs changed-test selection, not the full
integration/headless projects.

**Fix (systemic, not per-test-file)**: `unlockAchievement`'s `lootBox` branch
now pre-checks `world.generatedEquipmentRegistry.runKey === null` and returns
`false` (fails closed, no throw, no unlock recorded) before ever calling the
resolver — mirroring the equipment branch's existing feature-availability
pre-check pattern. A round-4 reviewer then found the **identical latent bug
shape already present in the equipment branch** (`getFloor2EquipmentRewardsAccess`
gates on floor + feature flags but never checks the run key itself); no
current call site combines "flags enabled" with "no run key" today, but it's
the same shape directly adjacent in the same function this slice touched, so
it was fixed with the identical guard for consistency and defense-in-depth.
Both branches now have direct regression tests in
`tests/game/achievement-system.test.ts` proving `unlockAchievement` returns
`false` without throwing and records neither an unlock nor a bundle when the
run key is null.

**Systemic recommendation for a future slice (not implemented here, out of
scope)**: `createGameWorld` (`src/core/world.ts`) has no default run key,
unlike `createTestWorld`. Consider giving `createGameWorld` the same
seed-derived default to prevent this landmine shape from recurring at other
resolver call sites.

## Verification run

- `npm run typecheck` — clean.
- `npm run verify:fast` — green, 783 unit tests (59 files).
- Full `--project integration`: 24 files / 187 tests, all green (re-run in
  full, not just changed-file selection, specifically to catch the class of
  regression above).
- Full `--project headless`: 24 files / 148 tests, all green.
- `npm run review:ledger -- validate <ledger path>` — passes.
- `npm run verify:pr-prereqs` — run before PR open.

## Unresolved issues / accepted risk (documented in ADR 0070, not fixed here — out of scope for this slice)

1. Two pre-existing save-tampering vectors (forged `claimedIds`/`unlockedIds`
   arrays bypassing achievement gating entirely) predate this slice; local
   save tampering only, no network/multiplayer trust boundary crossed —
   consistent with the game's existing client-authoritative save posture.
2. Schema version bump `v1` → `v2` and the new fail-closed lootBox reverse-
   guard both break restoring a same-session pre-merge save with the old
   shape — zero-risk since there is no shipped release / live player base
   yet.
3. `createGameWorld`'s missing default run key (see recommendation above).

## Recommended next steps

- None required for this slice — it is complete and ready to merge.
- A future slice could give `createGameWorld` a seed-derived default run key
  (see recommendation above) to close the landmine class generally, rather
  than relying on individual call sites remembering to pre-check or supply
  one.
