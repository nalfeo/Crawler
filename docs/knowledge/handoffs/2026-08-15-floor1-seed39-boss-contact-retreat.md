# Session Handoff: Fix Floor 1 seed-39 boss-contact retreat regression

## Date

2026-08-15

## Persona

Game AI Engineer

## Systems touched

ai-combat-balance, ai-pathfinding

## Apples

3🍎 estimated, 3🍎 actual (exact — investigation, fix, and review-harness ledger all fit the estimate)

## What Was Done

Fixed the release-sweep regression from issue #2991: Floor 1 seed 39 with forced
`throwing-knife` died against the stair boss (`rat-slime`), a genuine regression
introduced by PR #2988's retreat-scoring bugfix (a butterfly effect — #2988 targeted
seed 32, not 39). Confirmed via `git worktree` at the pre-#2988 commit that the
same seed/weapon wins there.

Root cause: the boss is spawned with `attackRange=280` (`spawnFloor1StairBoss()` in
`src/game/floorScenario.ts`) for its long-range acid-projectile ability, but also
deals normal melee contact damage once it closes in. `buildRetreatBehavior()` in
`src/game/ai/bt-ai-provider.ts` has a bail-out — "a real shooter, let Engage's
kite/strafe handle it" — keyed purely on the `attackRange` stat, with no check on
the threat's _current_ distance. Once the boss physically closed to melee/contact
range (~1-4ft) at critical player health, Retreat still deferred to the boss-room
"arena lock-in" ranged-orbit kite, which only special-cases clearing nearby _adds_
(not the boss itself), and could not create separation fast enough (HP 20%→8%→0%
in ~0.5s).

Fix: added `&& threat.distance > CONTACT_SAFE_ORBIT_FT` to the bail-out condition,
so it only defers to Engage while the threat is genuinely still at range.

Observed in the real headless pipeline (`npm run ai:headless`, not a lab): before
the fix, seed 39 + `throwing-knife` produced `DEATH` at frame 18313; after the fix,
the same seed/weapon produces deterministic `VICTORY` (confirmed via 2 paired
reruns).

## Key Decisions Made

- Fixed the bail-out predicate itself (in `Retreat`, which sits above `arena
lock-in` in BT-selector priority) rather than adding a boss-specific carve-out
  inside `buildArenaLockinBehavior()` — the latter would have duplicated logic
  Retreat already owns.
- Did not lower the boss's `attackRange` stat, since that also gates its
  legitimate ranged-projectile-firing ability in `enemyAISystem.ts` — changing it
  would alter real gameplay, not just this AI heuristic.
- Did not widen `RETREAT_HYSTERESIS_MULT`/`retreatDangerRadius` globally, since
  that would change retreat timing for every Floor 1/2 encounter, not just this
  boss's melee-contact edge case.
- Used `CONTACT_SAFE_ORBIT_FT` (an existing constant already used elsewhere in
  the same file) as the contact-distance threshold rather than inventing a new
  one, per the plan-review's own note that this is currently "double duty"
  (orbit-spacing constant reused for retreat-eligibility semantics) — flagged as
  a follow-up idea, not required for this fix.

## What's Next / Blockers

None blocking. Follow-up ideas surfaced by the plan-review (not applied, out of
scope for this narrow bugfix):

- The mid-floor `slime-rat` boss (`attackRange=220`, also melee-capable) may have
  the same latent shape; worth a dedicated coverage pass if it ever regresses.
- Consider a dedicated named constant for "contact danger threshold" instead of
  reusing `CONTACT_SAFE_ORBIT_FT`, to avoid retuning orbit feel silently
  retuning retreat eligibility.
- Watch for potential RETREAT↔ENGAGE boundary thrash right at the
  `CONTACT_SAFE_ORBIT_FT` threshold if a threat oscillates around it; add a
  release-buffer/hysteresis on the contact gate if it ever shows up in sweep
  telemetry.

## Retrospective

### Lessons Learned

- No tool in this environment can post a _fresh_ comment on a GitHub issue or PR
  (only `engine-tools-reply_to_comment`, which requires an existing comment ID
  to reply to). When a maintainer explicitly asks for a plan comment on the
  issue itself before coding, the best available substitute is publishing the
  full plan into the PR description via `engine-tools-report_progress` before
  writing any fix code — flag this limitation explicitly rather than silently
  treating it as satisfied.
- `git worktree add <path> <historical-sha>` is an efficient way to prove a
  regression is genuine (vs. pre-existing flake) without disturbing the working
  tree or needing a second `npm install` (`node_modules` is a shared junction
  across worktrees in this repo's environment).
- The review-harness `independent_grade` stage's `collectDiff()` diffs the
  **committed** git tree, not the working tree — changes must be `git commit`ed
  locally before `npm run review:grade -- prompt` will see them.

### Mistakes Made

- Initially wrote the `plan_review`/`code_review` ledger stage JSON with field
  shapes that didn't match the ledger schema (e.g. `plan_divergence` needs one
  of `convergent`/`minor`/`major_fork`, not free text; `code_review.rounds[]`
  entries need `models`/`clean`/`concerns_count`/`resolved_count` fields, and
  `resolved_count` must be `>= concerns_count`). `npm run review:ledger --
validate` caught this immediately with clear error messages — always run
  `validate` right after each `stage` call rather than assuming the write
  succeeded cleanly.
- The session `code_review` tool flagged that the new headless regression test
  used `maxWallTimeMs: 300_000`, which exceeds the Vitest test's own
  `120_000`ms timeout — copied uncritically from the existing
  `floor1-bow35-release-regression.test.ts` pattern, which has the same latent
  mismatch (not fixed here, out of scope, but worth flagging for a future
  cleanup pass across all `floor1-*-regression.test.ts` files).

### Opportunities for Future Improvement

- Audit all existing `tests/headless/floor1-*-regression.test.ts` files for the
  same `maxWallTimeMs` (300s) vs. Vitest test-timeout (120s) mismatch found in
  this session's new test — the runner's own controlled timeout should always
  stay safely below the outer Vitest timeout so a genuine hang reports the
  runner's message instead of a generic Vitest kill.
