# Floor 2 achievement content: 30 Floor 2 + 6 run-global achievements

## Systems touched

achievements, floor2

## Summary

Authored the missing Floor 2 achievement content per the Floor 2 equipment epic
contract: **27 new Floor 2 achievements** (bringing the total from 3 to **30**) and
**6 new run-global achievements** (bringing the run-global total from 0 to **6**).
Migrated Floor 2 achievement content from the inline `FLOOR2_ACHIEVEMENT_DEFS` array
in `src/shared/achievements.ts` to a data file
(`src/shared/data/achievements.floor2.json`), mirroring the existing Floor 1
JSON-data pattern, so content review stays separate from schema/logic review.

Persona: Content Designer. Apple estimate: **4🍎** (single PR, per explicit sign-off
from the requester). Review harness: adversarial plan review + code-review loop +
multi-model review, all recorded in
`docs/knowledge/review-ledgers/2026-07-29-floor2-achievement-content.review-ledger.json`
(valid).

## Decision: JSON-data migration

**Yes**, matching Floor 1. `achievements.floor2.json` now holds all 36 defs (30
floor-scoped + 6 `scope: 'current_run'`); `achievements.ts` loads/parses it the same
way it already loads `achievements.floor1.json`. Rationale: keeps a 30+-entry content
array out of the schema/logic file, matches the established review pattern (content
diff vs. code diff reviewed separately), and removes the asymmetry between Floor 1
and Floor 2 content storage.

## Achievement content

- 3 pre-existing kill-count achievements kept unchanged
  (`floor2-field-kit`/`floor2-second-wind`/`floor2-veteran-cast`).
- 27 new Floor 2 achievements grounded in real, already-implemented Floor 2
  mechanics: family reputation (Friendly/Hate bands via `bandFor`/`getRelation`),
  betrayal (see below), family bosses (`decapitatedFamilies`), settlement/Broker
  quests, the win/leave-floor path (`run_end_clear` phase), Quartermaster
  patronage, safe rooms, staircase/territory control, equipment unlock, gold,
  abilities, skill level, stat points, and quest-log/exploration breadth.
- 6 run-global achievements (`scope: 'current_run'`), spanning kills/gold/skill/
  abilities (introduced `floor: 1`, visible from run start) and cleared-floor-count/
  equipment-unlocked (introduced `floor: 2`, since those systems only exist once
  Floor 2 is reached) — deliberately mixing both floor-introduction gates so
  `getCurrentRunGlobalAchievements`'s floor-reached filtering is meaningfully
  exercised by tests (a Floor-1-only reached-set hides the two Floor-2-gated
  entries).
- Rewards: existing tier1/tier2/tier3 equipment reward shape only. Rarity stays
  within Common/Uncommon (per `EQUIPMENT_REWARD_TIER_RARITIES`) — **Unique is never
  used**, satisfying the epic's explicit deferral. All equipment rewards resolve
  once, immutably, at unlock time via the existing resolver — no new reroll path
  introduced.
- Voice: `directorFlavor` follows `.github/instructions/flavor.instructions.md`
  (wry, production-crew framing). Measured floor1's actual sentence-count practice
  per difficulty tier (basic avg 4.0, standard avg 4.9, hard avg 8.3 — the doc's
  literal upper bounds are aspirational even for floor1) and brought floor2's text
  up to that real bar (basic ~3, standard ~4, hard ~6) across 35 of 36 entries, with
  genuine new jokes/production details rather than mechanical padding.

## New facts added (all computed live in `achievementSystem.ts`, no edits to

`floor2Scenario.ts` — sibling-owned)

| Fact                                              | Type    | Source                                                                                |
| ------------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `familyBossesDefeated`                            | number  | `floorExtendedState.familyState.decapitatedFamilies.size`                             |
| `familyBossEncounterCount`                        | number  | boss-encounter map, filtered on `started === true` (not raw `.size` — see bugs below) |
| `familiesEngagedInCombatCount`                    | number  | per-family combat-encounter map, filtered on `kills > 0`                              |
| `allPresentFamiliesEngagedInCombat`               | boolean | `presentFamilyCount > 0 && familiesEngagedInCombatCount === presentFamilyCount`       |
| `familiesAtFriendlyCount` / `familiesAtHateCount` | number  | `presentFamilies` filtered by `bandFor(getRelation(...))`                             |
| `allPresentFamiliesFriendly`                      | boolean | dynamic threshold vs. `presentFamilies.length` (roster is 3 **or** 4 families)        |
| `hasBetrayedAlly`                                 | boolean | see below — **not** the dead `betrayerFlag`                                           |
| `floor2SafeRoomVisited`                           | boolean | `world.floor === 2 && isInSafeContext(world)`                                         |
| `hasMetBroker`                                    | boolean | `world.goalFlags.get(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID)`                           |

None of these are used by any run-global achievement; the 6 run-globals reference
only the pre-existing `ACHIEVEMENT_CURRENT_RUN_*` allowlisted facts.

## Bugs found and fixed across three review rounds

1. **(Adversarial plan review)** Two facts (`familyBossEncounterCount`,
   `familiesEngagedInCombatCount`) were computed from raw `Map.size` over maps that
   are eagerly pre-seeded for every present family at floor init — not lazily
   populated on real player action — so achievements referencing them could unlock
   without any real gameplay. Fixed by filtering on the map's own
   `started === true` / `kills > 0` discriminator.
2. **(Adversarial plan review)** "Court Favorite" hardcoded a `>= 3` friendly-family
   threshold, but Floor 2's roster (`selectFloor2Roster`, `fourProb = 0.4`) can be 3
   **or** 4 families — the achievement was silently unreachable on 4-family rosters.
   Fixed with a dynamic `allPresentFamiliesFriendly` boolean fact.
3. **(Adversarial plan review)** "Off This Floor" had no explicit rule phase and
   defaulted to `tick`, but `confirmFloor2StairDescend` only flips the relevant
   state during the `run_end_clear` phase, right before `world.state` becomes
   `'safe_room'` (which gates the entire tick pipeline off). Fixed by setting
   `phase: run_end_clear` on the unlock rule.
4. **(Multi-model review, mcr-sonnet)** The **same 3-vs-4-family threshold bug
   recurred** on a sibling achievement, "Scorched Earth" (`familiesEngagedInCombatCount
   > = 4`), unreachable on the majority-case (60%) 3-family roster. Fixed with a new
dynamic `allPresentFamiliesEngagedInCombat` boolean fact, same pattern as #2.
5. **(Multi-model review, mcr-codex)** "Double Agent"'s `hasBetrayedAlly` fact was
   driven by `familyState.betrayerFlag`, which is **only ever set `true` inside
   `src/labs/family-territory-lab/index.ts`** (a dev sandbox never run in
   production) — `floor2Scenario.ts` only ever initializes it `false`. The
   achievement was permanently unreachable in real gameplay. Fixed with a new
   `hasBetrayedFriendlyFamily()` helper deriving betrayal from two already-tracked,
   real-facts signals: a present family currently reading `bandFor(getRelation(...))
=== 'friendly'` **and** with `trashKillsByFamily > 0` recorded against it.
   Relation values only change via explicit `factionRelationDeltas`
   (settlement/emergent events), not combat kills, so this is a robust proxy with
   no new tracking and no sibling-file edits.
6. **(Multi-model review, mcr-codex + mcr-gemini, independently)** ~25
   `directorFlavor` entries ran noticeably shorter than floor1's actual
   per-difficulty practice (see Voice, above). Rewrote 35 of 36 entries.
7. **(Multi-model review, mcr-sonnet, lower severity)** A doc comment on the
   hand-duplicated `floor2-broker-intro-complete` goal-flag string claimed the
   general fact-computation test "covered" keeping it in sync with
   `floor2Scenario.ts`'s exported constant — but that test only exercised
   achievementSystem's own local behavior and would not catch a rename on either
   side. Fixed by exporting the constant (test-only use) and adding a dedicated
   drift-guard test that imports both copies and asserts equality; corrected the
   comment to point at that specific test.

The `floor2Scenario.ts`-importing-`achievementSystem.ts` circular-dependency
constraint (item 7 above, and the reason the broker-intro-complete goal-flag string
is duplicated rather than imported) is real and confirmed by direct inspection:
`floor2Scenario.ts` imports `evaluateAchievementUnlocksForPhase` from
`achievementSystem.ts` at module scope.

## Tests added/updated

- `tests/game/achievement-system.test.ts` — new fact-computation unit tests for
  every new/changed fact (friendly/hate bands, boss-encounter/combat filtering,
  the two dynamic all-present booleans, betrayal derivation positive + 2 negative
  cases, safe-room live-check, broker-flag read, broker-goal-ID drift guard), plus
  an integration test constructing full `GameWorld` state and asserting a
  representative sample of new achievements unlock correctly.
- `tests/property/achievement-facts-properties.test.ts` — bumped the boolean-facts
  arbitrary array from 10 to 11 entries to cover `allPresentFamiliesEngagedInCombat`.
- Catalog/reward tests (`tests/unit/achievements.test.ts`,
  `tests/unit/achievement-reward-presentation.test.ts`,
  `tests/unit/devtools/achievements-canvas-adapter-parity.test.ts`) — exercised
  unchanged but re-run to confirm the 36-entry catalog still loads/validates and
  presents correctly.
- Deterministic assertions: exact counts (30 Floor 2 + 6 run-global), all 36 IDs
  unique, no achievement ever declares/resolves Unique rarity, every reward tier
  valid, run-global scoping + floor-gating behavior of
  `getCurrentRunGlobalAchievements`.

## Verification run

- `npm run typecheck` — clean.
- Targeted suite: `tests/game/achievement-system.test.ts`,
  `tests/property/achievement-facts-properties.test.ts`,
  `tests/unit/achievements.test.ts`,
  `tests/unit/achievement-reward-presentation.test.ts`,
  `tests/unit/devtools/achievements-canvas-adapter-parity.test.ts` — **5 files, 60
  tests, all passing**.
- `npm run verify:fast` — passed.
- **Observe before done**: rendered the full catalog in the `achievements-ui-lab`
  and `achievements` canvas mid-session and visually confirmed correct
  presentation/claim flow for a sample of the new entries (see prior checkpoints).
  The behavior-change verification calls the real production entry point
  `achievementSystem(world)` (not a lab stub) in
  `tests/integration/floor2-reward-bundle-claim.integration.test.ts`, but the
  world state used is manually constructed — not produced by a running Floor 2
  game or headless runner. A full end-to-end Floor 2 headless pipeline that
  exercises the fact-producing mechanics (emergent events, kill routing, staircase
  descent) through to achievement evaluation does not yet exist; that is a
  separate Floor 2 win-path automation epic. The reachability of each fact was
  validated by manually tracing the production code paths (`emergentEventSystem`,
  `quests.floor2.events.json`, kill-tracking) rather than by observing a live run.
- **CI recovery pass (2026-07-30)**: a code review found that six relationship
  achievements used thresholds unreachable via shipped mechanics. The production
  event system (`quests.floor2.events.json`, `emergentEventSystem`) was
  analysed: relations start at 45 (hostile band), the highest single-family
  value achievable via all positive events is ~68 (neutral band 50–75), and the
  Friendly band (76+) is never reachable without wiring additional mechanics.
  All six achievements were re-scoped to neutral-or-better criteria, and the
  `hasBetrayedAlly` derivation was updated from `friendly`-only to
  `neutral-or-better`, making it reachable. A headless Floor 2 runner does not
  yet exercise the full achievement pipeline end-to-end (that requires Floor 2
  win-path automation, a separate epic), so the validation path here is: (a)
  analysed production mechanics manually, (b) updated integration tests to cover
  the reachable cases, (c) confirmed all facts are exercised through
  `achievementSystem(world)` in `floor2-reward-bundle-claim.integration.test.ts`
  using the real runtime entry point.

## Review ledger

`docs/knowledge/review-ledgers/2026-07-29-floor2-achievement-content.review-ledger.json`
— valid 4-apple ledger: adversarial `plan_review` (gpt-5.4, 6 concerns/6 resolved,
`plan_divergence: minor`), `code_review` (claude-sonnet-4.6, round 1, clean),
`multi_model_review` (claude-sonnet-4.6 + gpt-5.3-codex + gemini-3.1-pro-preview,
adjudicated by claude-opus-4.8, round 1, 3 valid concerns/3 resolved, clean).

## Files touched

- `src/shared/data/achievements.floor2.json` (new, 36 entries)
- `src/shared/achievements.ts` (JSON-loader wiring, new boolean-fact registrations)
- `src/game/systems/achievementSystem.ts` (new fact computations, `hasBetrayedFriendlyFamily`
  helper, exported `FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID`)
- `tests/game/achievement-system.test.ts`
- `tests/property/achievement-facts-properties.test.ts`
- `docs/knowledge/review-ledgers/2026-07-29-floor2-achievement-content.review-ledger.json`
- `docs/knowledge/metrics/guard-telemetry/2026-07-30-floor2-achievement-content.json`

**Not touched** (sibling-owned, per explicit instruction): `src/game/floor2Scenario.ts`,
`src/core/floor2-equipment-flags.ts`, `src/core/quartermaster-purchase.ts`.

## Post-review fix round (2026-07-31)

Human review of the PR flagged 3 blocking items. All 3 fixed on the same branch:

1. **Red CI (`Integration Tests`).** Two root causes, both fixed at the source
   (not weakened): a stale `seedFloor2Kill` test fixture that no longer matched
   real gameplay shape, and an `npm audit`/`fast-uri` dependency exception that
   needed updating in `scripts/agent/security/npm-audit.mjs` +
   `package.json`/`package-lock.json`. A **third** CI failure surfaced during
   this fix round's own `verify:fast`: `floor2-reward-bundle-affinity.property.test.ts`
   asserted `instance.rarity` is never `'rare'` for **any** tier — a hard-coded
   invariant from before `tier4` existed. Fixed by asserting rarity is within
   `EQUIPMENT_REWARD_TIER_RARITIES[tier]` (the actual per-tier contract) instead
   of a blanket exclusion; also corrected the file's stale doc comment claiming
   no tier could ever resolve `rare`.

2. **Generic-counter density.** The reviewer's instruction was to cut **at
   least half** of the ~10 bare-threshold-read achievements (gold/ability
   counts), not swap which counters were used. Original first pass dropped 2
   quest-log-size achievements but _added_ a third gold tier and third ability
   tier — net movement ~zero. Fixed by collapsing to **exactly one** gold
   achievement (`floor2-pocket-change`) and **exactly one** ability-count
   achievement (`floor2-new-tricks`), removing `floor2-comfortable`,
   `floor2-deep-pockets`, `floor2-growing-arsenal`, `floor2-loaded-toolkit`
   entirely, and backfilling with 4 Floor2-grounded replacements built from
   already-computed-but-previously-unused facts:
   - `floor2-staircase-spotted` (`staircaseDiscovered`, basic/tier1)
   - `floor2-breach-the-gate` (`staircaseBattleStarted`, standard/tier2)
   - `floor2-braved-the-dens` (`familyBossEncounterCount >= 2`, standard/tier2)
   - `floor2-no-den-unbraved` (new `allPresentFamilyBossesEngaged` derived
     boolean — mirrors the existing `allPresentFamiliesFriendly`/
     `allPresentFamiliesEngagedInCombat` pattern: dynamically checks against
     the _actual_ present-family roster size, 3 or 4, not a fixed threshold —
     hard/tier3)
   - **Explicitly rejected backfill candidates, because no observable signal
     exists for them today** (per instruction: state this rather than
     substitute another counter): **territory control** — `trashTerritories`
     in `world.ts` is a static init-time archetype assignment, not a live
     tracker; **cave traversal** — no distinct tracked event; **den clears
     without taking damage** — no per-den damage-taken tracking exists;
     **Quartermaster purchase/interaction** — would require reading state
     gated behind `getFloor2EquipmentEconomyAccess`, the same flag sibling PR
     #2333 confirms is "currently gated off by an unset flag"; gating an
     achievement on a not-yet-live feature would violate "every achievement
     must be unlockable by already-implemented gameplay."

3. **Rare-rarity rationale.** ADR 0070 originally deferred a Rare-capable tier
   entirely ("Deviation note"), and the code comments asserted "no tier may
   ever resolve Rare" as if it were a hard contract rather than a choice —
   but the epic explicitly permits Common/Uncommon/**Rare** (only Unique is
   deferred), so a `hard`-difficulty achievement being unable to ever reach
   the epic's best allowed rarity was an unjustified gap, not policy. Decision:
   **added a real `tier4`** (`EQUIPMENT_REWARD_TIERS` gains `'tier4'`,
   `EQUIPMENT_REWARD_TIER_RARITIES.tier4 = ['rare', 'uncommon']`), reserved for
   `difficulty: 'brutal'` achievements only — the 3 hardest, full-floor-mastery
   unlocks (`floor2-family-annihilator`, `floor2-floor-cleared`,
   `floor2-scorched-earth`, each requiring engagement/defeat of every present
   family on the floor). `tier1`-`tier3` **remain** intentionally Uncommon-capped
   for `basic`/`standard`/`hard` — this is now recorded explicitly as a
   **deliberate design decision** (not an artifact of reusing the tier shape):
   Floor 2's top _achievements_ intentionally cap at Uncommon; only the
   _hardest_ (`brutal`) unlocks reach Rare, and Unique remains out of scope
   epic-wide. Rationale is recorded in ADR 0070's new "Amendment (2026-07-31)"
   section, which also documents the change is additive/zero-risk (no
   exhaustive switch over tier values in the resolver;
   `RARITY_EFFECT_BUDGET.rare` already existed). The run-global gauntlet
   achievement (`floor2-run-two-floor-gauntlet`, hard/tier3) was deliberately
   **not** promoted to tier4 — the reviewer's "hardest achievements" ask was
   read as the 3 floor-scoped full-floor-mastery achievements specifically.

### Tests added/updated for this fix round

- `tests/unit/achievements.test.ts` — rewrote the Unique-rarity test to also
  assert tier4/brutal pairing; added a dedicated "never resolves Rare outside
  tier4" test.
- `tests/game/achievement-system.test.ts` — new 3-case test for
  `allPresentFamilyBossesEngaged` (3-family, 4-family-partial, 4-family-full),
  mirroring the existing `allPresentFamiliesFriendly` test; updated the
  Floor-1-zero-facts test.
- `tests/property/achievement-facts-properties.test.ts` — grew the boolean-facts
  arbitrary array 12→13 and added the `allPresentFamilyBossesEngaged` mapping
  (required for `tsc` to pass).
- `tests/property/floor2-reward-bundle-affinity.property.test.ts` — fixed the
  stale "never rare" property assertion (see CI fix above).
- Re-verified: exact 36-entry count (30 floor-scoped + 6 current_run), unique
  IDs, no stale references to the 4 dropped achievement IDs anywhere in the
  repo, all reward tiers valid.

## Unresolved issues / recommended next steps

- None outstanding. All review-harness findings (adversarial plan review + code
  review + multi-model review) and all 3 human-review blocking items were
  fixed and verified, not deferred.
- Two minor items noted but explicitly deferred as out-of-scope hardening (recorded
  in the plan-review ledger notes, not defects): stricter JSON catalog validation
  (suggestion only), and the eternal duplicated broker-goal-ID string constant
  (kept duplicated by design to avoid a real circular import; now has a drift-guard
  test instead of being imported).
- If the equipment economy flag (PR #2333, sibling session) changes reward
  resolution behavior in the future, re-verify that this PR's reward-resolution
  tests still pass — no dependency existed at merge time. PR #2333 remains open
  and red as of this fix round; not a blocker for this PR since no dependency
  was assumed.

## Post-merge branch situation and the `tier4` / PR #2341 collision (2026-07-31)

While fixing the 3 human-review blocking items above, `gh pr view 2339` revealed
**PR #2339 had already been squash-merged** to `main` — the reviewer's feedback
had arrived after the merge, not before it. The fix work up to that point had
been made as uncommitted changes on the now-deleted, already-merged local
branch. Recovery: stashed the uncommitted fixes (`git stash push -u`), created a
fresh branch `floor2-achievements-postmerge-fixes` off updated `origin/main`,
then `git stash pop` to replay the fixes — producing genuine merge conflicts
against everything that had landed on `main` since the squash-merge.

Most conflicts were mechanical (main had independently re-fixed the same two
`npm audit` findings this session had also patched — took main's newer,
re-verified versions outright) or additive-but-disjoint (main had also added a
new `allPresentFamiliesNeutralOrBetter` boolean fact at the same array index
this fix round's `allPresentFamilyBossesEngaged` used — both facts are real and
needed; resolved by growing the property-test's boolean arbitrary from 12 to 13
entries and giving each fact its own index).

One conflict was a genuine design collision, not a mechanical merge: a sibling
PR (#2341, "85%/15% Uncommon/Rare boss-chest rarity split") landed after #2339
merged and **independently added its own `tier4`** — reserved exclusively for
boss chests, with the achievement-schema enum
(`ACHIEVEMENT_EQUIPMENT_REWARD_TIERS`) hard-excluding it. This fix round's
Rare-rationale work (blocking item 3, above) had **also** added a `tier4`,
reserved for achievements only. Neither PR knew about the other's `tier4`.
Merging both as written would have made the achievement content's 3 `brutal`
rewards fail Zod schema validation outright — a hard break, not a style
disagreement, and squarely rule #11 territory (never silently reinterpret an
established contract). Escalated to the human via `ask_user` rather than
guessing.

**Resolution (human's explicit call)**: `tier4` is now **one shared
Rare-capable tier**, used by both boss chests and `brutal`-difficulty
achievements, at the boss-chest PR's 85%/15% Uncommon/Rare split
(`EQUIPMENT_REWARD_TIER_RARITIES.tier4 = ['uncommon', 'rare']`, weight `0.85`
adopted from #2341's already-in-place weight table rather than this session's
original `['rare', 'uncommon']` choice). `ACHIEVEMENT_EQUIPMENT_REWARD_TIERS`
/ `AchievementEquipmentRewardTier` are now plain aliases of the full
`EQUIPMENT_REWARD_TIERS` set — not a narrower 3-tier exclusion — so the
achievement schema accepts `tier4` achievements directly. No behavioral change
for boss chests: the tier is a rarity-pool lookup, not a chest/achievement-type
discriminator, so sharing it introduces no new coupling. Recorded as a second
amendment to ADR 0070 (see `docs/knowledge/adr/0070-achievement-reward-content-tiers.md`).

All 3 original review items (CI red, generic-counter density, Rare rationale)
remain fully addressed on the new branch; typecheck and the full targeted test
set (unit + integration + property, 123 tests across the touched files) pass.
This is being published as a **new PR** referencing #2339 as prior context,
since #2339 itself is already merged and its branch deleted.
