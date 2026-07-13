# Handoff — Floor 1 mandatory-route optimizer plan

**Date:** 2026-07-13
**Branch:** `nalfeo-plan-route-efficiency`
**Session:** Route efficiency
**Status:** Planning/investigation complete; **no implementation has begun**
**Estimated complexity:** 5 apples

## Systems touched

ai-behavior-tree, ai-pathfinding, ai-combat-balance

## Verdict and bounded ask

**Recommended with caution.** Five healthy Floor 1 runs fail only because the AI
orders independently legal mandatory objectives inefficiently. The approved
future implementation is a bounded deterministic precedence-constrained route
optimizer over the complete outstanding mandatory Floor 1 route. It must not
become a merchant-versus-Slime special case, seed/weapon-specific policy, or a
timing/accounting change.

The unchanged official-win rule remains:

```ts
stats.outcome === 'victory' && activeTimeMs(stats) < 360_000;
```

Exactly 360,000 active milliseconds is nonofficial. Do not increase the budget,
runner cap, simulation speed, or safe-room credit.

## Investigation evidence that will not transfer

The local JSONL, summaries, and console captures were session-only files under
`files/route-efficiency-traces/`; they will not survive machine migration. Their
durable findings are summarized here.

The bounded local investigation ran five failures and exploratory seed52 controls
before the maintainer selected cleaner adjacent cloud comparators. Do not run
additional exploratory local cases when resuming; the implementation validation
set is the exact ten cases specified below.

All five failures ran to the unchanged 23,760-frame observation cap (396 raw
seconds), retained 75.0–96.7% minimum health, and recorded zero
`suppressedProgressNav`. They completed the merchant and Spell Broker work but
entered the leave-floor phase too late.

### Target phase evidence

Times below are raw game seconds. The last milestone is Broker completion /
leave-floor acceptance.

| Target                | Welcome | Tutorial | Shop accepted | Broker accepted | Shop complete | Broker complete / leave accepted |     Active end |
| --------------------- | ------: | -------: | ------------: | --------------: | ------------: | -------------------------------: | -------------: |
| seed53 baseball-bat   |    19.7 |     46.6 |          49.9 |            50.6 |         162.2 |                            351.3 | 384.73 timeout |
| seed53 bow            |    19.5 |     54.1 |          61.7 |            62.4 |         189.3 |                    340.8 / 340.9 | 382.85 timeout |
| seed53 sword          |    19.7 |     42.7 |          46.8 |            47.6 |         159.1 |                            347.5 | 384.73 timeout |
| seed71 baseball-bat   |    26.8 |     53.3 |          56.4 |            55.6 |         187.3 |                            362.5 | 387.38 timeout |
| seed71 throwing-knife |    27.0 |     65.3 |          68.3 |            67.4 |         206.7 |                    356.6 / 356.7 | 384.58 timeout |

Opening progression is not the shared defect: tutorial completion spans
42.7–65.3 seconds. The first shared wasted-time divergence occurs when multiple
mandatory nodes become legally available. Legacy `findProgressObjective()`
serializes the merchant chain before the Broker chain even though the canonical
interaction resolver permits both after level 2.

The resulting late route legs were:

| Layout | Item → shop path | Shop → Slime path | Slime → Broker path |
| ------ | ---------------: | ----------------: | ------------------: |
| seed53 |   1,051–1,103 ft |    1,616–1,628 ft |      1,593–1,684 ft |
| seed71 |   1,166–1,212 ft |          1,594 ft |      1,472–1,598 ft |

This is efficient movement toward a poor order, not wiggle or idle behavior.

### Adjacent healthy controls

Use the existing cloud results at workflow SHA `a8e26a51`, originally stored
under `post1043-sweep/<weapon>/validate-legacy+legacy.json`:

| Comparator            | Active time | Minimum health | Final level |
| --------------------- | ----------: | -------------: | ----------: |
| seed54 baseball-bat   |      337.2s |          96.7% |           6 |
| seed54 bow            |      299.6s |          98.3% |           7 |
| seed54 sword          |      313.2s |           100% |           7 |
| seed70 baseball-bat   |      253.5s |          91.7% |           6 |
| seed70 throwing-knife |      248.9s |          95.8% |           4 |

Seed54 is the adjacent comparator for seed53. Seed70 is the adjacent,
representative comparator for seed71. Seed52 had a weak-health knife run; seed72
was unusually fast. Neither is the approved control cohort.

## Approved systemic design

Build one deterministic precedence-constrained optimizer over all outstanding
mandatory Floor 1 spatial objective, reward, and turn-in nodes.

### Route registry and legality

The current registry has at most 11 spatial nodes:

1. Tutorial Goon interaction.
2. Shopkeeper introduction.
3. Merchant item pickup.
4. Merchant item return.
5. Merchant buy interaction.
6. Merchant equip interaction.
7. Broker quest acceptance.
8. Slime Rat encounter.
9. Broker reward turn-in.
10. Staircase boss encounter.
11. Stairs interaction.

Each descriptor supplies a stable ID, legacy ordinal, reachable anchor, executor
kind/interaction intent, canonical prerequisites, deterministic planning effects,
work estimate, commitment kind, and critical-chain phase.

Derive prerequisites from the real quest/interaction systems, not legacy BT
ordering:

- Level 2 gates both Shopkeeper and Broker interaction.
- Item return requires actual possession.
- Buy/equip require the real shop/economy stages.
- Slime Rat requires Broker acceptance.
- Broker reward requires Slime Rat defeat.
- Boss/stairs use canonical goal flags.
- An active boss/arena precedes every unrelated remaining node.

Level grind, kill quota, and gold farming are non-spatial work barriers attached
to spatial actions, not TSP vertices. The optimizer must not predict random loot;
actual gold-threshold crossing is a replan milestone.

### Solver and bounds

- Precompute pairwise travel costs with existing reachable NPC anchors and
  `estimateObjectiveTravelMs` A\*/fallback adapters.
- Cache the matrix by floor identity plus ordered anchor identities/tiles.
- Defer prerequisite-locked geometry rather than letting a straight-line fallback
  mis-rank unavailable branches.
- Solve legal sequences with memoized topological Held-Karp DP keyed by
  `(completedMask, currentNode)`.
- Hard cap: `MAX_FLOOR1_ROUTE_NODES = 12`.
- Worst bounds at 12 nodes: 49,152 memo states, 589,824 candidate transitions,
  and 144 pairwise path estimates.
- Equal costs use the complete legacy-ordinal sequence lexicographically.
- Invalid/overflow plans emit typed diagnostics and warned stable legacy fallback;
  normal Floor 1 runs may never hit fallback.

The optimizer must be able to choose completing both eligible objectives before
returning for both rewards when that is the cheapest legal route. This is expected
output, not a hard-coded merchant-first/Slime-first branch.

### Shared planner/execution contract

Return one `Floor1MandatoryRoutePlan` with ordered node IDs, next node, segment
costs/phases, unchanged slack/urgency inputs, milestone/anchor fingerprint,
transition count, and diagnostics.

`estimateFloor1RunPlan()` and the BT consume this same route. Registry IDs and
executor IDs must be exhaustively checked. Existing node executors preserve
suppression/watchdog behavior, quest-giver detours, interaction radius, tactical
enemy/gold work, arena commitment, reasons, and telemetry.

### Navigation foundation dependency — block implementation until merged

This work depends on the navigation route-constraint foundation documented by
**ADR 0060**. Do not add provider-private navigation commitment state.

The integration contract is:

- `MovementIntentArbiterState` owns the current lease and optional immutable
  `NavigationCommitmentState`.
- The route optimizer owns only route DP, canonical milestone state, and route
  fingerprints.
- Route execution emits data-only progression movement proposals plus commitment
  fingerprints through the shared movement arbiter.
- Consumers receive and handle explicit `invalid`, `arrived`, `stalled`,
  `cleared`, and `reseed` lifecycle outcomes.
- Keep route planning/cache invalidation separate from navigation lease
  ownership/lifecycle.

Resume implementation only after confirming the ADR 0060 foundation PR is merged
into current `main`, then rebase/start a fresh implementation branch from that
main.

### Commitment and replanning

Commit to the planned next route node between real milestones. The route
fingerprint includes floor/map and anchor identities, outstanding/completed IDs,
quest/goal milestones, item possession, shop stage, gold-threshold readiness,
boss/arena state, spell/stair state, and current-target validity.

Do not replan for player position, normal movement, ordinary gold increments, or
FOV reveal. Replan for fingerprint change, node completion, invalid anchor/target,
floor/reset, or explicit arbiter invalidity. Panic, suppression, stall recovery,
and opportunistic detours temporarily override movement without advancing the
route; arbiter lifecycle outcomes decide whether to resume, clear, or reseed.

## Exact validation gates

### Local — exactly ten real-headless cases

Failures that must become official:

- seed53: baseball-bat, bow, sword.
- seed71: baseball-bat, throwing-knife.

Adjacent controls that must remain official:

- seed54: baseball-bat, bow, sword.
- seed70: baseball-bat, throwing-knife.

For every target, require strict `isOfficialWin(stats, 360_000)`, all mandatory
quest completions including `floor1-leave-floor`, and no death/stall/error.
Route telemetry must prove both eligible objective nodes complete before both
reward/turn-in nodes on the affected layouts.

For controls, require official wins, no death/stall/error, and minimum health no
more than five percentage points below the baselines above.

Also add:

- Solver legality, deterministic ties, cap/transition bounds, invalid/overflow,
  active-boss, item/economy, and deferred-geometry tests.
- A two-chain merge test oracle for generated small merchant/Broker DAGs.
- Property tests that replay emitted actions against the real quest/interaction
  resolver using `createTestWorld()`.
- Registry/executor exhaustiveness.
- Shared planner/BT route identity and no position-driven replan/oscillation.
- Milestone/anchor invalidation, reset/floor change, and arbiter lifecycle tests.
- Panic/suppression/detour pause-resume and no remote interaction.
- Browser AI-runner max-node replan below 8 ms p95 and no >16.7 ms milestone
  long task.

Run focused unit/game/headless tests, `npm run verify:fast`, `npm run scope`, the
5-apple review harness, ledger validation, and `npm run verify:pr-prereqs`. Do not
run a broad local sweep or routine full verify.

### Cloud — mandatory pre-merge paired 600-run gate

Run canonical paired 600-run GitHub sweeps for current main and the PR branch
before merge. Require:

- All five target cases official.
- Zero main official-win → PR nonwin flips.
- No increase in deaths, stalls, or errors.
- At least 90% overall Floor 1 official win rate.
- Per-weapon official rates, active-time distributions, route-order counts,
  minimum-health distributions, and optimizer invalid/overflow counts.
- Zero optimizer invalid/overflow fallback in normal Floor 1 runs.

Separately reclassify the ten known raw victories at 360.6–386.9 active seconds
with unchanged `isOfficialWin`. Runs remaining at/above 360 seconds remain
correctly nonofficial; actual route improvements may move them below 360. They are
not accounting defects.

## Ranked tiebreakers and non-goals

Ranked soft tiebreakers:

1. Zero official-win, progression, survival, or legality regressions.
2. Smallest implementation surface consistent with the general optimizer.
3. Largest median active-time/travel reduction in the late-timeout cohort.
4. Preserve seed54/70 outcomes, survival, and panic behavior.
5. Lowest replan transition count/browser cost.
6. Clear diagnostics and future descriptor extension.

Non-goals: final-travel survival, general kiting, safe-room parking,
weapon/combat/enemy/loot/economy tuning, quest/map/NPC placement redesign, global
pathfinding replacement, budget/cap/delta/accounting changes, and seed/weapon
production branches.

## Fresh-clone resume instructions

1. Clone/fetch `nalfeo/Crawler`.
2. Confirm this planning branch and handoff are present:
   `git fetch origin nalfeo-plan-route-efficiency`.
3. Read this handoff, ADR 0060, current `docs/knowledge/handoffs/INDEX.md`, and the
   latest navigation-foundation handoff.
4. Confirm the ADR 0060 movement-arbiter foundation PR is merged into `main`.
5. Start a **new implementation session/branch from current `main`**; do not build
   implementation commits on this planning branch.
6. Run `bash scripts/agent/preflight.sh`, adopt Producer → Game Designer/QA,
   re-check the 5-apple estimate, and initialize the review ledger before code.
7. Reconfirm current APIs for `MovementIntentArbiterState`,
   `NavigationCommitmentState`, progression movement proposals, and lifecycle
   outcomes before designing executor wiring.
8. Implement the phases above without rerunning exploratory diagnostics.
9. Use exactly the ten local target/control cases and the mandatory paired
   600-run pre-merge cloud gate.

## Closure state

No source code, tests, tuning, scoring, runner configuration, or quest data were
changed in this session. No PR was opened and no implementation began.
