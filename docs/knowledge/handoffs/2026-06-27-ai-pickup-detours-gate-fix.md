# Handoff — AI Pickup Detours: Headless Gate Fix + Dodge-Suppression Test

**Date:** 2026-06-27
**Session:** ai-pickup-detours-gate-fix
**Persona:** Systems Engineer (shepherding PR #336 to merge — original session archived)
**Apple estimate:** 🍎🍎🍎🍎 | **Actual:** 🍎🍎🍎 | **Verdict:** 📈 over

## Context

Took full ownership of **PR #336** (`fix(ai): detour for loot within 5 ft of the
forward path`, branch `nalfeo-ai-pickup-detours`) after the building session was
archived. Two blockers stood between the PR and merge:

- **A — real CI failure:** `Headless Floor 1 Gate` failing (run 28256149376). The
  `Merge gate` / `ci` aggregate checks failed only as a consequence.
- **B — actionable Copilot review comment** on `bt-ai-provider.ts:1226`: the new
  "suppress the loot detour while a dodge is active this frame" branch — the whole
  reason Dodge was reordered before Collect in the Track B parallel — was not
  exercised by any of the 5 new tests.

## Blocker A — Root Cause

Only **one** gate assertion failed: seed 3 · bow's **wall-time perf-regression
guard** (`HEADLESS_WALL_TIME_BUDGET_MS = 30_000`). It came in at ~36.8s on CI
(17 233 frames). Game-time, outcome, and quest assertions all passed — so the
detour did **not** break Floor 1 completion, it just made it _slower_.

CPU profiling (`node --cpu-prof`) put **~79% of wall-time in ROT.js A\***, of which
**~75% was enemy pathfinding** (`followPathWithCaching` → `findTilePath`); the loot
scan itself was <0.5%. Controlled A/B (detour on vs off):

- per-frame wall-time **2.74ms → 5.16ms** (~2x)
- enemy re-paths **7 605 → 14 033** (+85%)

Mechanism: the on-path detour perturbs the player's trajectory, so the player **and
every chasing enemy** change tiles more often. The per-enemy path cache keys on
`enemyTile|targetTile|traversal|doorRevision` and re-paths on **any** key change,
defeating the `DEFAULT_PATH_REFRESH_FRAMES = 10` throttle. ~61% of `findTilePath`
calls were redundant (identical keys recomputed across enemies / oscillating
target tiles).

**Weight-tuning was rejected** as the fix: sweeping `collectPullWeight` is chaotic
(non-monotonic frame counts) and would have been tuning the test to the budget, not
fixing the cost.

## Blocker A — The Fix

`src/game/enemyAISystem.ts`: a **per-world, door-revision-scoped shared path memo**.

`findTilePath` is a pure function of the floor's static walls plus the live door
states; the only runtime mutator of tile passability is a door opening/closing,
which `getDoorRevision` already folds into the cache key. So within a revision,
every enemy re-pathing from the same tile toward the same target tile computes a
**byte-identical** path — historically once _per enemy, per refresh_. The memo
(keyed on the same `pathKey` string, cleared whenever the door revision changes)
collapses those redundant searches — including repeated _failed_ searches to an
unreachable target — into one. Cached arrays are read-only
(`nextWaypointDirection` only reads `.length`/indexes), so sharing one array across
enemies is safe and allocation-free.

**Why it's safe (determinism proof):** ran a 12-combo frame-count harness with and
without the memo and `Compare-Object`'d the results — **all 12 seed x weapon combos
are byte-for-byte identical** (e.g. 15·sword=14439, 3·bow=17233, 7·bat=19254). The
memo changes _cost_, never _outcome_.

**Result:** seed 3 · bow single-combo headless run **~15s** locally (was ~37s on
CI) — comfortable headroom under the 30s budget.

## Blocker B — The Test

`tests/game/behavior-tree-ai.test.ts`: `suppresses the loot detour while dodging a
charging enemy (idle-wander)`.

The dodge-suppression gate is only reachable in **one** Track-A state: `EXPLORE`
with a `null` target (idle-wander). Any _reachable_ enemy within the engage radius
(>=160px) flips Track A to `ENGAGE` (and the existing not-while-fighting test is
gated out there, never reaching the `dodgeVec` gate); any _reachable_ on-path gem
flips it to `COLLECT`. The escape hatch is a **reachability asymmetry**:
`findNearestEnemy`/`findNearestLoot` skip A\*-unreachable targets, while the
dodge/detour scans reason in **raw pixel space**.

So the test builds a 1-tile-tall corridor (`makeSealedCorridor`, 20px tiles) split
by a wall column into two A\*-disconnected floor segments. The player wanders the
left segment heading +x; the on-path gem and a charging enemy sit on the
disconnected right segment — **pixel-close** (the scans react) but **unreachable**
(reachable-target selection skips them, so the AI stays `EXPLORE`+`null`). A control
(gem only) detours (`hypot(pull) > 0.5`); adding the charging enemy
(`velocity.x = -3`) zeroes the pull while the dodge fires
(`hypot(dodge) > 0`, `pullX === 0`, `pullY === 0`) — isolating the dodge as the
suppressor. 20px tiles keep the >=3-tiles-past-the-wall placement (needed to clear
`resolveReachableGoalTile`'s radius-2 approach search) inside the 120px grab /
96px dodge radii. `createTestWorld({ seed: 5 })`, `SeededRandom` only.

The review thread is replied to and **resolved**.

## Files Changed

| File                                  | Change                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/game/enemyAISystem.ts`           | Shared door-revision-scoped path memo (`sharedPathMemoByWorld` + `getSharedPathMemo`) wired into `followPathWithCaching` |
| `tests/game/behavior-tree-ai.test.ts` | `makeSealedCorridor` helper + dodge-suppression test (exercises the `dodgeVec` gate)                                     |

Commits: `perf(ai): memoize enemy paths to absorb loot-detour pathfinding load`,
`test(ai): cover dodge suppression of the loot detour`.

## Validation

- `npm run verify:fast` ✓ (typecheck + lint + 188 unit tests)
- `tests/game/behavior-tree-ai.test.ts` ✓ (6 detour tests incl. the new one)
- Headless gate seed 3 · bow ✓ wall-time guard now passes (~15s)
- `bash scripts/agent/lab-gate-check.sh` ✓
- 12-combo determinism A/B ✓ byte-identical with/without the memo

## Notes for Next Agent

- The memo benefits **all** combos, not just seed 3 · bow — it's a general
  redundant-A\* eliminator, not a seed-specific patch. If you ever add per-enemy
  path _mutation_ (e.g. dynamic per-enemy traversal costs not folded into the key),
  the "pure function of the key" invariant breaks and the memo must key on the new
  input too.
- The reachability-asymmetry trick (`makeSealedCorridor`) is reusable for any test
  that needs an entity visible to pixel-space scans but invisible to reachable
  target selection (i.e. forcing/holding the AI in idle-wander).
- No `files/guard-telemetry.jsonl` present this session, so no guard-telemetry
  section to paste.

## Apples

Estimated 🍎🍎🍎🍎, actual 🍎🍎🍎 (📈 over, delta −1). Went in fearing a Large
deterministic-logic rework of the pathfinding/detour interaction; the root cause
localized to a cacheable redundancy, so the actual change was a clean 2-file,
behavior-preserving memo plus one test — Medium in surface area, even though the
diagnosis (profiling + determinism proof + the reachability-asymmetry test design)
carried Large-level rigor.
