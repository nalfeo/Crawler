# Session Handoff: Shepherd PR #765 — consolidate Floor 1 quest NPCs into welcome bar

## Date

2026-07-05

## Persona

Producer (PR Shepherd)

## Systems touched

mapgen, ai-behavior-tree, ci-policy

## Apples

2🍎 estimated, 4🍎 actual (💥 miss — three bot rebases each spawned a fresh Copilot review pass; scope grew from a 1-line typecheck fix to two real placement bug fixes + a hot-path perf refactor + an AI test + a cross-system ADR (Phase 2), an apple-calibration + PR-scope correction (Phase 3), and a non-vacuous ranged-preemption test rewrite + two `origin/main` merge-conflict resolutions (Phase 4)). `|delta| = 2` maps to `miss` per `verdictFromDelta`.

## What Was Done

Shepherded PR #765 from `BLOCKED`/`MERGEABLE` to a clean squash-merge.

- **Fixed the real CI failure** (`Types & Lint`, TS2540): the added test
  `treats shared-room merchant goals as direct NPC progress targets` assigned to
  `objective.shopRoomPos` / `objective.spellQuestGiverPos`, which are `readonly`
  on `FloorObjectiveState`. Reassigned the whole (mutable) `objective` via a
  spread instead of mutating readonly fields — type-safe, no type weakening.
  `npm run typecheck` + `npm run verify:fast` green afterward.
- **Verified the review-thread concern** (Copilot reviewer: three `spawn`-role
  NPCs stacking on one `welcomeOfficePos` tile). The generic fix was already on
  the branch (`resolveNpcSpawnPosition` + an `occupiedTiles` set gives each
  hub NPC a distinct free tile; `findNearestNearbyNpc` makes shared-room hubs
  individually selectable). Observed in the real headless scenario
  (`initializeFloor1Scenario`) via `tests/game/floor1-scenario.test.ts`
  "keeps welcome-bar quest NPCs in one room but on distinct tiles":
  before the fix all three resolve to `welcomeOfficePos` → `uniqueNpcTiles.size === 1`;
  after, across 10 seeds `uniqueNpcTiles.size === 3` and the objective positions
  tighten to the actual spawned tiles. Targeted run: 90/90 tests pass.
- Replied `✅ Addressed` on the thread and owner-resolved it, then armed
  `gh pr merge 765 --auto --squash`.

### Phase 2 — bot-rebase review pass (unplanned, +2🍎)

A `rebase-prs` bot rebase onto advancing `main` triggered a fresh Copilot review
pass that posted **6 new threads** on the rebased head. All addressed:

- **Two real NPC-stacking bugs** in `src/game/floorScenario.ts`:
  - `resolveFreeNpcTileInRoom` returned the first sorted interior tile (or
    `null`) immediately; when a room enumerated `interiorCells` but every free
    one was already claimed it returned `null`, pushing the caller onto its
    preferred-tile fallback and re-introducing stacking. Now it falls through to
    the bounds/radius spiral scan when no free interior cell remains.
  - `resolveNpcSpawnPosition`'s preferred-tile fallback checked only
    `isPassable`, ignoring `occupiedTiles` — so it could hand back a tile another
    NPC already claimed. Now it also requires `!occupiedTiles.has(tileKey(...))`.
- **Per-frame allocation** in the `MainGameScene` interaction hot path
  (`src/engine/scenes/main-game-scene-helpers.ts` +
  `src/engine/scenes/MainGameScene.ts`): `findNearestNearbyNpc` took a freshly
  `Array.from(...)`-built candidate array every frame. Refactored it to take the
  npc `ReadonlyMap` + position store arrays and iterate in place — no per-frame
  garbage. Updated the call site and strengthened
  `tests/unit/main-game-scene-interaction-priority.test.ts` (added none-nearby
  and empty-map cases).
- **Missing retreat coverage**: added a deterministic 3-poll test in
  `tests/game/behavior-tree-ai.test.ts` that drives `endRetreat`'s
  threat-ignore latch (`ignoredEnemyUntilFrame`) — low HP + nearby threat →
  RETREAT, threat disengages → latched as ignored, threat returns → still ignored
  (no RETREAT relatch).
- **Scope disclosure** (two threads): the branch also carries combat-AI changes
  (ranged-engagement preemption, retreat hysteresis + ignore latch,
  leave-safe-room detour). Disclosed them in the PR description and recorded a
  cross-system **ADR** (`docs/knowledge/adr/2026-07-05-floor1-welcome-bar-npc-consolidation.md`)
  — required because the diff spans `src/engine` + `src/game` (2+ layers).

`npm run verify:fast` green (315 changed unit tests); `VERIFY_FULL=1 npm run verify`
re-ran the Headless Floor 1 Gate to confirm the win-rate holds (no seed bending,
rule #13). A `code-review` subagent pass was run on the diff as a proportionate
quality gate for the grown scope.

### Phase 3 — second bot-rebase review pass + apple calibration fix

A further `rebase-prs` rebase re-ran Copilot review and posted **2 more threads**;
both addressed and owner-resolved:

- **Apple calibration bug (real):** the apple JSON had `hello_kitties: 0.1`, but
  the canonical formula (`apple-calibration-lib.ts:127`) is
  `hello_kitties = actual_apples / 5`; with `actual_apples: 3` the correct value
  is `0.6` (matches sibling `actual=3` apple files). Corrected in `1a1b12f7`.
- **PR-description scope (re-quote):** the reviewer re-flagged the "only quest NPC
  positioning" framing from the pre-rewrite description. Already handled — the
  description now discloses the full combat-AI scope and the cross-system ADR
  documents it; replied to that effect and resolved.

Full-suite `test:unit` was green both with (3770) and without (3767) the Phase 2
changes, and the 2 modified test files pass alongside the sidecar/floor2 tests
that flaked once in an early `VERIFY_FULL` run — confirming that flake was a
one-off (network/env-timing-sensitive sidecar tests), not a regression. The
branch was reconciled twice against bot rebases via
`reset --hard origin/<branch>` + cherry-pick/stash-pop (origin is the
authoritative rebased superset; the Phase 2 diff re-applies by context).

### Phase 4 — vacuous-test rewrite + two `origin/main` merge conflicts

A final Copilot pass flagged the ranged-preemption test in
`tests/game/behavior-tree-ai.test.ts` as **vacuous**: it placed the close enemy
as the nearest target, so `findNearestEnemy` selected it directly and the
preemption branch in `planRangedEngagement` — which only fires when the primary
target is beyond `contactThreatRadius` — never executed. Deleting the branch
would not have changed the outcome. **Rewrote it** (commit `7fec7162`) to drive
the progress-enemy path: a far quest enemy (in `enemyArchetypes`) becomes the
primary `decision.targetEid`, while a close non-quest threat inside
`contactThreatRadius` redirects _movement_. **Proved non-vacuous** by temporarily
forcing the preemption guard to `false` and re-running: the test fails
(`reason` becomes `Closing to ranged standoff (6.0ft) from 30.0ft` and
`targetX > playerX` instead of orbiting the near threat to `-X`), then restored
the source (git diff confirmed test-only). This is the "observe before done"
before/after for the fix.

During the shepherd window `main` advanced twice, requiring merge-conflict
resolution: **PR #764** (spawner battle arena, `4af3fee4`) → a trivial
"both-added" reset-field union in `bt-ai-provider.ts` (kept all three reset
assignments; merge `4dd26415`); **PR #775** (labs fix, `cc4e84a9`) → clean,
non-overlapping (merge `6ef4f8cf`). Typecheck + `verify:fast` + targeted tests
re-validated after each; all required CI (`ci` aggregate, `commit-lint`,
Headless Floor 1 Gate) green on the reconciled head.

## Key Decisions Made

- Fixed the test around the requirement (readonly objective positions) rather
  than relaxing the type — the `readonly` guard on objective positions is
  intentional and must not be weakened just to green a typecheck (rule #12).
- Trusted CI's required Headless Floor 1 Gate for win-rate re-validation: the
  only new commit is test-only, so it cannot move the win-rate, and the gate
  re-runs on the new head as the authoritative check (rule #13 — no seed bending).
- Kept the shared-room `spawn` role for the welcome-bar NPCs and hardened the
  generic `resolveNpcSpawnPosition` de-dup rather than hard-coding per-NPC roles
  or fixed offsets (documented in the ADR alternatives) — the generic path is
  reused by future shared-room hubs and stays covered by the multi-seed test.
- Left the existing 1🍎 review ledger as authored: the shepherd follow-ups are
  fixes on an existing PR, the ledger guard only fires on `create_pull_request`
  (not invoked here), and retroactively bumping the tier would demand fabricated
  heavier review stages. Instead ran a `code-review` subagent as a proportionate
  quality gate and recorded the true scope in this handoff + apple JSON + ADR.

## What's Next / Blockers

None for this PR — armed for auto-merge; branch auto-deletes on squash.

Pre-existing, out-of-scope doc-rot noticed (NOT fixed here — unrelated to the
floor1 change, and `check-adr-consistency` is a non-required docs-loop check that
the green head already passes): `docs/knowledge/adr/0043-*.md` references
`coverage/balance-metrics.json` (gitignored generated artifact) and
`docs/knowledge/adr/0044-*.md` references `scripts/agent/health/check-size-coverage.ts`
and `src/core/physics-defs.ts`, none of which exist on disk. A docs-focused
session should correct or drop those stale path references.

## Retrospective

### Lessons Learned

- `FloorObjectiveState` positional fields are `readonly` but the containing
  `FloorScenarioState.objective` property is mutable — the idiomatic test-side
  override is `world.floor1!.objective = { ...world.floor1!.objective, ... }`,
  not per-field mutation.
- The distinct-tile guarantee is best observed in the real scenario init
  (`initializeFloor1Scenario`) as a deterministic multi-seed assertion, not a
  lab — this is the correct "observe before done" artifact for a layout change.
- To confirm a behavior test is non-vacuous, temporarily neutralize the branch
  under test (e.g. force its guard to `false`) and re-run: it must fail. A
  ranged-preemption test is only meaningful when the _primary_ target is beyond
  `contactThreatRadius` (drive it via the progress-enemy path with a far quest
  enemy) and a _different_ close threat exists — otherwise `findNearestEnemy`
  picks the close enemy directly and the preemption branch never runs.

### Mistakes Made

- Estimated 2🍎 up front. The initial CI+thread scope really was ~1🍎 (the
  overlap fix — `06439a92 fix: support shared-room NPC hubs` — was already
  implemented and test-covered), but a `rebase-prs` bot rebase then triggered a
  fresh review pass with 6 new findings that grew actual work to ~3🍎. Two
  lessons: (a) read the full branch diff before estimating; (b) on a strict/
  up-to-date repo, expect bot rebases to spawn new review passes and budget the
  shepherd estimate for a possible second round of findings.
- Shipped two test/doc files (`main-game-scene-interaction-priority.test.ts`, the
  new ADR) that failed Prettier `format:check` on the first `VERIFY_FULL` run —
  `verify.sh` aborts at the format step, wasting a full run. Run
  `npm run format` (or `prettier --write` on new files) before the long verify.

### Opportunities for Future Improvement

- A shared test helper (e.g. `setObjective(world, patch)`) would remove the
  repeated readonly-objective spread boilerplate and prevent the TS2540 class of
  error in future floor-scenario tests.
