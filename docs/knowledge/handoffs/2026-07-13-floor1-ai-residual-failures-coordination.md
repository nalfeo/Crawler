# Handoff: Floor 1 residual AI failures coordination

## Date

2026-07-13

## Systems touched

ai-behavior-tree, ai-pathfinding, ai-combat-balance, boss-rooms, quests, ci-policy

## Purpose

This branch preserves the investigation and coordination state for the remaining
Floor 1 AI failures after the July 11 sweep. Resume implementation from the
dedicated remote branches below, not from this coordinator branch.

## Last accepted broad baseline

- Source SHA: `a8e26a5189fd587c0abba2371f0d0d3387484344`
- Official wins: 556/600 (92.67%)
- Per weapon: fireball 98, bow 94, pistol 94, sword 93, baseball-bat 90,
  throwing-knife 87.
- Non-wins: 17 deaths, 17 timeouts, 10 raw victories after the strict active-time
  budget.
- Official win remains `outcome === "victory"` and
  `gameTimeMs - safeRoomMs < 360000`.
- The 10 late victories were correctly classified, not an accounting defect.

## Failure taxonomy and combat evidence

Ten bounded local captures separated deaths into two families:

| Family                                   | Mean DPS | Accuracy | Damage taken/s | Wiggle |
| ---------------------------------------- | -------: | -------: | -------------: | -----: |
| Final boss entry/transit representatives |     19.0 |    76.8% |           1.03 |   2.2% |
| Early attrition/kiting representatives   |      7.5 |    48.7% |           1.26 |  18.1% |

Key cases:

- Seed 8 with bat/bow/pistol and seed 94 with throwing knife had strong combat
  throughput. The eventual root cause was invalid boss-room geometry and unsafe
  encounter startup, not weapon balance.
- Seed 78 sword: 70.8% accuracy but 2.71 damage taken/s and death around 43s.
- Seed 82 throwing knife: premature low-health Retreat release.
- Seed 18 throwing knife: 15.8 DPS, 41.2% accuracy, 41.2% wiggle; safe-room
  egress is the first divergence.
- Seed 54 fireball: 37 activations over about 220s, 1.4 DPS, 37.8% accuracy;
  prolonged egress/retreat behavior, not global fireball weakness.
- Seed 94 throwing knife: 17.5 DPS, 75.2% accuracy, about 1% wiggle; control
  proving throwing-knife damage can be sufficient.

Timeout families:

- Severe safe-room parking: bow 40/74/97, pistol 74/76, knife 48/49.
- Healthy route inefficiency: bat 10/53/58/60/71, bow 53, sword 53, knife 71.
- Low-progression attrition: sword 18 and knife 62.

## Workstreams and remote resume points

### Boss-room geometry and encounter startup

- PR: #1110, branch `nalfeo-plan-final-stair-survival`
- Remote head at handoff: `493b333cd19e489c05237a04d0f95168ad6cf681`
- Status: open, unmerged, implementation complete.
- Focused cloud gate superseded the broad gate by explicit human decision:
  28/28 official wins, zero deaths/stalls/timeouts/errors, max 323.65s under the
  unchanged 360s budget.
- The implementation repairs fragmented/invalid Floor 1 boss arenas
  deterministically and adds generic encounter-start decision invalidation.

### Navigation-layer safe-room route constraints

- Branch: `nalfeo-safe-room-route-constraints`
- Remote handoff head: `ece63a13629a748a0ac83558ee7dcbe6e9d0eef8`
- Status: WIP handoff, no PR; inspect its branch handoff for exact code/test state.
- Architecture decision: SafeRoomEgress must not be a semantic movement owner.
  Semantic owners retain their commitment while navigation inserts a reusable,
  deterministic safe-room exit segment.
- Immutable acceptance gate remains: at least 556/600 official wins, at most 11
  runs with more than 60s safe-room dwell, zero new long-safe flags among baseline
  official wins, bow 97 and pistol 76 official wins, unchanged 360s budget.

Rejected owner-based experiments:

| Candidate                                 | Wins | >60s safe flags |
| ----------------------------------------- | ---: | --------------: |
| Exclusive 30-frame egress                 |  524 |               3 |
| Two-frame discarded latch                 |  523 |              40 |
| Latched-yield                             |  532 |              40 |
| Full-proposal durable-owner Alternative A |  511 |              58 |

Alternative A lost 62 baseline wins and gained 17. Cross-weapon clusters at seeds
23, 24, 4, 7, 35, 57, and 79 proved the regression was geometry/ownership behavior,
not weapon policy. Do not revive SafeRoomEgress as an arbiter owner or tune a
release timer.

### Retreat and kiting

- Branch: `nalfeo-plan-retreat-kiting`
- Status at coordination handoff: plan/investigation only; no implementation.
- Root mechanic: Retreat can release on transient threat loss, blacklist the
  threat, and resume combat at critical HP. Seed 78 sword and seed 82 knife are
  structural gates; seed 94 knife is a control.
- Resume only after the navigation-route-constraint foundation lands. Retreat
  must consume the shared semantic-owner/navigation commitment seam and must not
  read private safe-room state or own duplicate progress counters.

### Mandatory objective route optimizer

- Branch: `nalfeo-plan-route-efficiency`
- Status at coordination handoff: plan/investigation only; no implementation.
- Root mechanic: fixed serial objective ordering creates 1.5k-1.7k-foot
  backtracking on seeds 53 and 71.
- Approved architecture: bounded deterministic precedence-constrained optimizer
  over all outstanding mandatory spatial objective/reward nodes (current maximum
  11, hard cap 12), with canonical prerequisites and one shared planner result.
- Required targets: seed 53 bat/bow/sword and seed 71 bat/knife.
- Adjacent controls: seed 54 bat/bow/sword and seed 70 bat/knife.
- Resume after the navigation-route-constraint foundation lands.

## Cloud telemetry limitation

The July 11 cloud rows carried terminal outcome, timing, score, XP, gold, level,
and minimum HP, but not DPS, accuracy, movement-intent transitions, path
efficiency, or event tails. A GitHub issue was filed requesting full downloadable
per-run diagnostics. Until that lands, preserve compact lifecycle summaries in
new sweep artifacts and use bounded local event captures only when a structural
field is missing.

## Resume order on a new machine

1. Fetch `origin/main` and all four branches named above.
2. Review/merge or continue PR #1110 independently.
3. Open a new session from `origin/nalfeo-safe-room-route-constraints`; read its
   branch handoff and finish the immutable focused/cloud gates.
4. Only after that foundation merges, start fresh implementation sessions for
   retreat and route optimization using their remote handoff branches as research,
   but branch implementation from then-current `main`.
5. After all slices land, run the canonical GitHub 100-seed x six-weapon sweep.
   Require every targeted case to win, at least 90% overall, and report per-weapon
   results without seed-specific tuning.

## Non-goals and safeguards

- Do not weaken the 360-second active-time definition.
- Do not tune weapons before movement/progression defects are resolved.
- Do not use seed- or weapon-specific production branches.
- Do not restore remote/through-wall interaction, teleportation, or direct quest
  completion.
- Broad sweeps remain GitHub-only.
