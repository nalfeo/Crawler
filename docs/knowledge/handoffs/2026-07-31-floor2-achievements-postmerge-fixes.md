# Floor 2 achievement content: post-merge review fixes + tier4 collision resolution

## Systems touched

achievements, floor2-equipment-economy

## Summary

Follow-up fix round for PR #2339 ("Floor 2 achievement content: 30 Floor 2 + 6
run-global achievements"). The full narrative, design decisions, and original
verification for that PR live in
`docs/knowledge/handoffs/2026-07-30-floor2-achievement-content.md` (now amended
with a "Post-merge branch situation" addendum covering everything below in
more detail). This handoff exists because that PR is **already merged**, so
this fix round ships as a **new PR** and needs its own handoff/ledger per repo
policy.

Three human-review blocking items were addressed:

1. **CI red** (`Integration Tests`): fixed the underlying test-fixture realism
   issue and an `npm audit` exception; both were later independently
   re-fixed on `main` by the time this branch rebased, so the final diff here
   takes `main`'s versions of the two audit files.
2. **Generic-counter density**: dropped 4 bare-threshold achievements
   (`floor2-comfortable`, `floor2-deep-pockets`, `floor2-growing-arsenal`,
   `floor2-loaded-toolkit`) and replaced them with 4 grounded in real Floor 2
   territory/den mechanics (`floor2-staircase-spotted`, `floor2-breach-the-gate`,
   `floor2-braved-the-dens`, `floor2-no-den-unbraved`), net density reduction
   as requested (gold and ability-count achievements now capped at one each).
3. **Rare rarity rationale**: added a genuine Rare-capable `tier4`, promoted 3
   `brutal`-difficulty achievements to it, and documented the rationale as an
   amendment to ADR 0070.

## The post-merge discovery and the tier4/PR #2341 collision

While implementing the 3 fixes above, `gh pr view 2339` revealed the PR had
already been squash-merged — the review feedback arrived after merge, not
before. All fix-round work had been made as uncommitted changes on the
now-deleted branch; recovered via `git stash push -u` → new branch off updated
`origin/main` → `git stash pop`, which surfaced real merge conflicts against
everything that landed on `main` since the merge.

Most conflicts were mechanical. One was a genuine design collision: sibling PR
#2341 ("85%/15% Uncommon/Rare boss-chest rarity split") independently added its
own `tier4`, reserved exclusively for boss chests via a hard achievement-schema
exclusion — while this fix round's item-3 work had independently added its own
`tier4` reserved for achievements only. Merging both as written would have made
the achievement content's 3 `brutal` rewards fail Zod schema validation
outright. Escalated to the human (rule #11 — never silently reinterpret an
established contract) rather than resolved unilaterally.

**Resolution (human's explicit decision)**: one shared Rare-capable `tier4`,
used by both boss chests and `brutal` achievements, at PR #2341's 85%/15%
Uncommon/Rare split. `ACHIEVEMENT_EQUIPMENT_REWARD_TIERS` is now a plain alias
of the full `EQUIPMENT_REWARD_TIERS` set rather than a narrower exclusion.
Full detail and the resulting ADR 0070 amendment: see the addendum in
`docs/knowledge/handoffs/2026-07-30-floor2-achievement-content.md` and
`docs/knowledge/adr/0070-achievement-reward-content-tiers.md`.

## Files touched

- `src/shared/achievements.ts` — doc comments describing tier4 as shared
- `src/shared/data/achievements.floor2.json` — density-fix content (4 drops, 4
  additions) + 3 tier4/brutal promotions
- `src/shared/generated-equipment-types.ts` — `tier4` merged as one shared
  Rare-capable tier (`['uncommon','rare']`, 85/15); achievement-side tier enum
  widened to include it
- `docs/knowledge/adr/0070-achievement-reward-content-tiers.md` — second
  amendment documenting the shared-tier4 resolution
- `docs/knowledge/handoffs/2026-07-30-floor2-achievement-content.md` — addendum
- Tests updated to match: `tests/unit/achievements.test.ts`,
  `tests/game/achievement-system.test.ts`,
  `tests/property/achievement-facts-properties.test.ts` (grew the boolean-facts
  arbitrary 12→13 to accommodate a fact `main` added independently,
  `allPresentFamiliesNeutralOrBetter`, alongside this round's
  `allPresentFamilyBossesEngaged`),
  `tests/property/floor2-reward-bundle-affinity.property.test.ts`,
  `tests/unit/floor2-reward-bundle-resolver.test.ts`,
  `tests/integration/floor2-reward-bundle-claim.integration.test.ts`

## Verification run

- `npm run typecheck` — clean
- Targeted unit/property suites (`achievements.test.ts`,
  `floor2-reward-bundle-resolver.test.ts`, `achievement-facts-properties.test.ts`,
  `floor2-reward-bundle-affinity.property.test.ts`, `achievement-system.test.ts`):
  84/84 passed
- Targeted integration suite (`floor2-reward-bundle-claim.integration.test.ts`):
  39/39 passed
- All re-verified after `npm run sync:main` rebased this branch cleanly onto
  the latest `main` (no new conflicts — main had not moved further since this
  branch's base)

## Review ledger

`docs/knowledge/review-ledgers/2026-07-30-floor2-achievements-postmerge-fixes.review-ledger.json`,
2-apple tier (no required stages) — scoped to concrete, well-specified
review-comment fixes plus one design collision that was itself escalated to
and resolved by the human directly (not something an automated review stage
would add signal over). Validated: `npm run review:ledger -- validate`.

## Unresolved issues / recommended next steps

- None outstanding for this fix round — all 3 original review items and the
  tier4 collision are resolved and verified.
- Same carryover from the original PR: PR #2333 (equipment economy flag) is a
  sibling concern, not a dependency; re-verify reward-resolution behavior if
  that flag's rollout later changes resolution logic.
- Not touched: `src/game/floor2Scenario.ts` (per the sibling-session boundary).
