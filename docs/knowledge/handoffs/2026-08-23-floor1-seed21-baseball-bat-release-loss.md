# Session Handoff: Fix Floor 1 seed-21 baseball-bat release-sweep loss

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-pathfinding, ai-combat-balance

## Apples

2🍎 exact

## What Was Done

Fixed the Floor 1 release-sweep loss reported in #3414
(`floor=floor1|seed=21|weapon=baseball-bat`), bisected to PR #3407 ("Restore
Floor 1 release-sweep win for pistol seed 5 by fixing Progress priority").

Reproduced the loss with the headless AI runner
(`npx tsx src/game/ai/headless-runner-cli.ts --seed 21 --weapon baseball-bat
--floor floor1 --max-frames 39600`): outcome was `TIMEOUT` — the Floor 1
collapse deadline (600s) expired with `floor1-leave-floor` still incomplete,
not a combat death.

Root cause: PR #3407 relocated the repeat spell-broker-purchase priority
check (`purchaseCount > 0`, `purchaseStatus === 'returning'`) in
`findProgressObjective` (`src/game/ai/bt-ai-provider.ts`) to fire whenever
both Floor 1 bosses are defeated — but this block, unlike every other
optional-detour path in the same method, never checked `panicProfile.beeline`
(the existing "abandon optional detours near the deadline" signal). In seed
21, the `abandoned → returning` gold-sufficiency recovery in
`spell-broker-intent.ts` (unchanged by #3407) fires late (~482s of 600s, only
~5.7s of planner slack left) while the player is far from the Spell Broker.
The unconditional override then commits to the full round trip regardless,
burning ~74s of combat-interrupted travel and blowing the deadline. The
pre-#3407 code positioned the same check _after_ settlement-return, so in
this specific seed it happened to fire earlier while the player was already
near the broker — a lucky, not principled, avoidance of the same gap.

Fix: added `&& !panicProfile.beeline` to the repeat spell-broker-purchase
override condition in `findProgressObjective`, reusing the existing
emergency-detour-drop mechanism instead of introducing a new one.

Observed in the headless runner (the real sim-side AI pipeline, not a lab):
before the fix, seed 21 / baseball-bat produced `Outcome: TIMEOUT`
(`floor1-leave-floor: accepted 224.6s, incomplete`); after the fix, the same
seed/weapon produces `Outcome: VICTORY`
(`floor1-leave-floor: accepted 224.6s, ✓ 591.0s`), confirmed both with and
without `--settlement-return-routing`.

## Key Decisions Made

- Rejected reverting the #3407 priority reorder: that reorder was itself a
  deliberate fix for a different regression (pistol seed 5); reverting it
  would just re-open that bug for a different seed.
- Rejected adding a bespoke travel-distance/round-trip estimate for the
  spell-broker detour: a much larger, unprecedented change. The existing
  `panicProfile.beeline` flag already exists for exactly this purpose
  ("drop optional detours, it's an emergency") and only needed to be wired
  into this one override block, which was the sole optional-detour path in
  `findProgressObjective` missing that gate.

## What's Next / Blockers

None. All 6 seeds in
`tests/headless/floor1-release-sweep-loss-regressions.test.ts` pass
(including the newly added `{ weapon: 'baseball-bat', seed: 21 }` case).
`npm run typecheck`, `npm run lint`, `npx vitest run tests/game`, and
`npm run verify:fast` all pass clean.

## Retrospective

### Lessons Learned

- `findProgressObjective`'s hardcoded priority overrides (evaluated before
  the goal-graph/route-planner is even consulted) can silently skip the
  planner's own feasibility/slack accounting entirely. Any new override
  added there should always be gated by `panicProfile.beeline` (or an
  equivalent explicit feasibility check) — the existing pattern used by
  `withQuestGiverDetour` — rather than assumed to be safe because "it only
  fires late in the run, after bosses are defeated."
- `updateSpellBrokerIntent`'s `abandoned → returning` recovery branch (in
  `spell-broker-intent.ts`) recovers purely on gold sufficiency, with no
  travel-time/slack re-check at all — this is a pre-existing gap (predates
  #3407) that made the newly-relocated override's lack of a panic gate
  actually exploitable. Not fixed here (out of scope — the `panicProfile`
  gate alone is sufficient and smaller), but worth flagging for anyone
  touching that lifecycle again.

### Mistakes Made

- Initially assumed the regression must be in the reordering relative to
  `settlementReturnIntent` or the changed boss-completion condition; both
  turned out to be red herrings once the actual failing decision was traced
  via targeted instrumentation of `updateSpellBrokerIntent` transitions
  correlated against the per-frame decision-reason event log. Lesson:
  instrument the actual state-machine transition timing before reasoning
  about priority-order deltas in a diff — a diff can look like a pure
  reorder while still exposing a pre-existing gap in a completely different
  module.

### Opportunities for Future Improvement

- Consider adding a genuine round-trip travel-time feasibility check to
  `updateSpellBrokerIntent`'s (and `updateMerchantWeaponIntent`'s) recovery
  paths, not just gold-sufficiency, so a "lowest-priority sink" purchase
  never re-commits this late regardless of which caller currently guards it.
