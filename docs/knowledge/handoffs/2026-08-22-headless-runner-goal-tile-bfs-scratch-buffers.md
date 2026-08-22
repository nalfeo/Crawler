# Session Handoff: Reuse BFS scratch buffers in goal-tile / NPC-anchor reachability (issue #3229)

## Date

2026-08-22

## Persona

Perf Optimizer

## Systems touched

ai-pathfinding, ai-behavior-tree

## Apples

2🍎 exact (no ledger required — see rationale below)

## What Was Done

Investigated issue #3229 ("Investigate speedup to headless runner without using
more compute — do not add parallelism, find a real single-process win ≥10%").

**Profiling (blocking gate, done before picking a target):** `npm run
perf:profile` (default panel: seeds 1–3 × sword) ranked functions by both
self% and total%. `floodReachabilityDepth` (`src/game/ai/bt-ai-provider.ts`)
was the hottest self-time leaf (~5.3% self / ~5.7% total). Traced its three
call sites:

- `computeExploreReachabilityDepth` — already reuses instance-level scratch
  `Int32Array`s (a precedent from a prior session).
- `computeReachableGoalTile` — **~6.3% of total run time**, essentially all of
  which is inside this one function because its caller's memo cache
  (`resolveReachableGoalTile`, keyed on `(startTile, goalTile, maxRadius)`)
  rarely hits: the player's tile changes on almost every AI poll while moving.
  Allocated two fresh full-floor `Int32Array`s (`dist`/`queue`) on **every**
  call.
- `resolveNpcInteractionAnchor` — same per-call allocation pattern, cold path
  (per-NPC cached), ~0.05% total — allocation removed for consistency/hygiene,
  not because it mattered on its own.

**Fix:** added four new instance-level scratch fields
(`goalReachabilityDepth`/`goalReachabilityQueue`,
`npcAnchorReachabilityDepth`/`npcAnchorReachabilityQueue`) mirroring the
pre-existing `exploreReachabilityDepth`/`exploreReachabilityQueue` pattern.
Both functions now lazily resize-and-reuse the shared buffer (`if (!buf ||
buf.length !== tileCount) buf = new Int32Array(tileCount)`) instead of
allocating fresh arrays, then reset with `dist.fill(-1)` before each BFS.

**Why this is gameplay-neutral:** the scratch arrays are pure local working
storage. Every return path in both functions was read line-by-line before the
change — each one returns only a plain `{x, y}`/`TilePoint` built from
primitives read out of the array, never the array itself or a view into it
(perf-optimizer skill mechanism #2, "encapsulated non-escaping"). The `-1`
reset is preserved exactly, so a stale value from a previous call's BFS can
never leak into the next call's read.

**Regression test:** added
`tests/unit/ai/reachable-goal-tile-scratch-buffer.test.ts` (7 tests) using a
small hand-built map (`makeOpenFloorMap` + a wall column, plus one solitary
carved-out wall tile for the NPC-anchor correctness oracle) so every expected
answer is known ahead of time, rather than an arbitrary generated-world tile
pair. Covers, for both functions: buffer-identity reuse across calls with
different inputs (the perf claim), non-corruption of an already-returned
result by a later call, and — critically — actual _correctness_, not just
mutual consistency: a directly-reachable goal must resolve to itself, an
impassable/unreachable goal must resolve to a different real passable tile
and never to the wall tile itself or the raw NPC position.

**Proved the tests can fail (blocking gate):** manually applied two mutations
to a scratch copy of the source and confirmed detection, then restored the
clean file (verified via `diff` against a backup) after each:

1. Always-reallocate (undo the reuse) — caught by the buffer-identity
   assertions in both describe blocks.
2. Drop the `-1` invalidation reset — an **early version of the test
   (generated-world fixture, arbitrary tiles) missed this entirely**: the
   broken and correct code paths coincidentally produced the same fallback
   answer for those specific tiles. Rewriting with the synthetic
   wall-column/wall-tile fixture (known ground truth) made the tests
   genuinely sensitive to this mutation for both functions.

**Runtime/real-artifact observation (rule #9/#10):** ran the actual headless
CLI (`node scripts/agent/perf/headless-bundle.mjs --seed 42 --weapon sword`),
5x before and 5x after, single process each. Also profiled 3-run samples
before/after with `npm run perf:profile --seeds 1-3 --weapons sword --json` to
isolate the target function's own numbers from end-to-end noise.

## Key Decisions Made

- **Did not chase a bigger target to force the 10% bar.** The Amdahl ceiling
  for this target (`npm run perf:profile -- --ceiling 6.3:1000`) is **6.29%
  end-to-end even at infinite speedup for the whole function** — an allocation
  fix inside it recovers only a fraction of that. The skill explicitly forbids
  bundling several sub-threshold changes to inflate a claim ("never bundle to
  clear the bar") and mandates one optimization per PR. Recorded this
  honestly below rather than manufacturing a bigger number or scope-creeping
  into a riskier, broader change.
- **Chose instance-level scratch fields over a module-level singleton.** A
  module-level buffer would be shared across every `BehaviorTreeAI` instance
  (multiple NPCs/enemies can run their own AI provider), risking cross-entity
  aliasing if two instances' calls ever interleaved. Instance-level scratch
  mirrors the existing, already-reviewed `exploreReachabilityDepth` precedent
  and keeps the blast radius to "per-provider, never shared."
- **Used a hand-built map fixture instead of the generated Floor 1 world for
  the regression test**, specifically because the generated-world version's
  correctness assertions turned out not to be sensitive to the invalidation-
  drop mutation (see "Mistakes Made"). Ground-truth control matters more than
  fixture realism for this kind of test.

## What's Next / Blockers

- This fix alone does not clear the issue's ≥10% end-to-end bar (see
  Performance measurements below) because its Amdahl ceiling is ~6.3%. If the
  10% target is a hard requirement, the next session needs a **new**,
  separately-profiled target — `runCoreSimulationStep` (~49% total),
  `enemyAISystem` (~15.7% total), and `behavior-tree.ts`'s `tick` (~12.5%
  total) are the next largest total% subsystems in this profile and were
  **not** investigated in this session (out of scope for "one optimization,
  smallest safe diff"). Any of them would need its own step-3 attribution
  pass before being trusted as a target — do not assume the self/total split
  observed here transfers.
- Could not post the plan-comment to GitHub issue #3229 from this sandbox:
  `gh issue comment`, `GH_TOKEN`-authenticated GraphQL, and raw `curl` to
  `api.github.com` all returned 403 "Blocked by DNS monitoring proxy" — a
  hard sandbox network-egress restriction, not a token/permission issue. The
  full plan text is preserved in this session's final report for a human/
  orchestrator to post via `gh issue comment 3229 --repo nalfeo/Crawler
--body-file <file>`.
- Changes are **uncommitted in the working tree** as of this handoff (per
  task instructions: do not push, do not open a PR, do not call
  `report_progress` — that is reserved for the orchestrating session).

## Performance measurements

- **Fingerprint neutrality (mandatory gate):** `npm run perf:fingerprint --
--write files/perf-baseline.json` on the clean tree, then `npm run
perf:fingerprint -- --check files/perf-baseline.json` after the fix, full
  gate sample (seeds 1–8 × sword/bow/baseball-bat, 24 runs). **Hash identical
  both times:**
  `65abeea0f651ff35cdf41f1192f37731f7ee41308a608de502655d9e35d562a2`. "RunStats
  identical: every run in the sample matches the baseline byte-for-byte."
- **Per-call win (real, measured):** `npm run perf:profile -- --seeds 1-3
--weapons sword --sort total --json`, identical seeds before/after:
  - `computeReachableGoalTile` self-time: **246.1ms → 66.0ms** (3-run sample,
    ~73% reduction in the function's own body time — the removed allocation).
  - `resolveNpcInteractionAnchor` self-time: 7.8ms → 13.3ms (cold path, too
    small a sample to be meaningful either direction).
- **End-to-end (honest, not dressed up):** total profiled sample time
  47824ms → 47276ms (~1.1%), and 5 direct single-process headless runs each
  (`node scripts/agent/perf/headless-bundle.mjs --seed 42 --weapon sword`):
  before-range 8.1–8.3s, after-range 8.1–8.2s — **overlapping distributions,
  inside noise** per the skill's own bar ("a win is credible only when
  before/after distributions do not overlap"). Consistent with the ~6.3%
  Amdahl ceiling computed for this target.
- **Conclusion:** this is a real, provably-correct, low-risk allocation
  removal with a measurable per-call win, but it does **not** meet the
  issue's stated ≥10% end-to-end bar on its own, and that is reported here
  plainly rather than inflated.

## Retrospective

### Lessons Learned

- `npm run perf:profile -- --ceiling <share>:<speedup>` is worth running
  _before_ investing in a fix, not just after: computing the 6.3% ceiling
  up front would have set expectations correctly from the start rather than
  only becoming clear after the wall-clock A/B runs came back inside noise.
- Sandbox network egress genuinely blocks all forms of new-issue-comment
  creation (`gh`, GraphQL with `GH_TOKEN`, raw `curl`) with a "DNS monitoring
  proxy" 403 — this is a hard environment limitation, not a credentials
  problem, and no MCP tool in this toolset creates a new issue comment
  (`engine-tools-reply_to_comment` only replies to existing PR review
  threads). Future sessions hitting the same wall should stop trying
  variations and hand the text to the human/orchestrator immediately.
- The `edit` tool advertised in the system prompt was not actually present in
  this session's toolset; `bash` + `python3` heredocs with an
  `assert content.count(old) == 1` guard worked as a reliable substitute for
  exact, single-occurrence string replacement.

### Mistakes Made

- The first version of the regression test used the real generated Floor 1
  world with essentially arbitrary start/goal tiles. It passed against the
  intended "always reuse the buffer" mutation but **completely missed** a
  genuine correctness mutation (dropping the `-1` reset): the broken and
  correct code paths happened to produce the _same_ wrong-but-plausible
  answer for those specific tiles (both degenerated to the same
  `bestGoal ?? goalTile` fallback). This is exactly the failure mode the
  skill's mutation-proof step exists to catch, and it did — but only because
  the mutation was actually tried rather than assumed passing from reading
  the test. Rewrote using a small synthetic map with known ground truth
  (a directly-reachable goal that must equal itself; an impassable goal that
  must resolve to a different real tile) to make the tests actually sensitive
  to this class of bug.
- The same near-miss repeated for `resolveNpcInteractionAnchor`'s test: an
  early correctness assertion (`anchorA` must not equal the raw NPC position）
  was added on the assumption that a reachable approach tile always differs
  from the NPC's own tile — false in general, since the NPC's own tile can
  legitimately be the closest reachable tile. That assertion failed on the
  _clean, correct_ code, which would have been "weakening a test to go
  green" if simply deleted. Instead, root-caused why it failed (the NPC's own
  tile was itself a valid passable candidate in that geometry) and fixed the
  test scenario properly by carving out a solitary impassable tile at the
  NPC's exact position, giving a scenario where the correct answer is
  provably a _different_ tile — restoring a real correctness oracle instead
  of removing the check.

### Opportunities for Future Improvement

- The next-largest total% subsystems in this profile
  (`runCoreSimulationStep` ~49%, `enemyAISystem` ~15.7%, behavior-tree `tick`
  ~12.5%) are candidates for a future, separately-scoped perf-optimizer
  session aimed specifically at clearing the ≥10% end-to-end bar from issue
  #3229 — each needs its own attribution pass (self vs. total, `← caller`
  containment check for any `node_modules` frames) before being trusted as a
  target; none of that work was done here and should not be assumed to carry
  over.
- Consider whether `resolveReachableGoalTile`'s memo cache could be made
  useful during movement (e.g. quantizing the start-tile key, or memoizing on
  a coarser region) — the profiling here confirmed the cache is nearly always
  missed _because_ the exact start tile changes every poll while the player
  moves, which is the root reason `computeReachableGoalTile` runs so often in
  the first place. A correctly-quantized cache could remove far more than the
  allocation churn alone, but changing cache _key_ semantics is higher-risk
  (3🍎+ per the skill's own escalation rule) and was out of scope for this
  session's smallest-safe-diff mandate.
