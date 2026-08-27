# Session Handoff: Floor 2 sealed-den softlock (release sweep `floor1-chain` < 90%)

## Date

2026-08-23

## Persona

Game AI Engineer → Systems Engineer (the failure bucket turned out to be scenario
state, not AI-runner behavior)

## Systems touched

boss-rooms, quests

## Apples

2🍎 exact (one localized scenario fix + deterministic regression coverage; no
review ledger required below 3🍎)

## What Was Done

Closed the `floor1-chain` 89.33% report-only leg regression by fixing a permanent
Floor 2 softlock: a den whose boss entity disappears mid-encounter stays sealed
with the player inside for the rest of the run.

Diagnosis used only the already-published release baseline payload
(`by-sha/80e7ea91b0e57d5773937d8a791b1a18c9b427f3.json` on the `baselines`
branch); no replacement sweep was dispatched.

`legs["floor1-chain"].runs` (150 runs) categorized by `outcome`:

| Outcome | Count |
| ------- | ----: |
| victory |   134 |
| timeout |    14 |
| stalled |     1 |
| death   |     1 |

**8 of the 16 failures — the single largest bucket — share one exact
`denBoss.families[<family>].final` signature:**

```
bossAlive:false  bossEid:null  encounterStarted:true  encounterDefeated:false
encounterGoalActive:true  denSealed:true  denDoorsLocked:2  denDoorsOpen:0
playerInDen:true
```

(chain-leg run indices 17, 40, 43, 54, 74, 80, 88, 142; families beetlefolk,
ratfolk, goblins, kobolds, molefolk, batfolk, faeries, pandas — always the
_last_ family, always with `floor2-leave-floor` accepted within ~0.4s of
`encounterStartedMs`.)

Read literally: the den boss entity is gone from the ECS, the encounter was
never latched defeated, so the den's relock goal `floor2-den-<id>-boss-active`
stays true and both den doors stay locked around the player. Meanwhile
`floor2VictorySystem`'s vanished-boss reconciliation latched floor victory and
popped the stairs — which the sealed-in player can never reach. The run burns
its remaining budget at `movementQuality.stuckPct` 4–36% and ends `timeout`.

Root cause: `floor2VictorySystem`'s reconciliation latched `decapitated` +
`floor2-family-<id>-boss-defeated` but never touched the encounter record, and
only the combat-event death path ever cleared `encounter.activeGoalId`.

Fix (`src/game/floor2Scenario.ts`):

- `latchFloor2FamilyDefeated()` — one home for every defeat route (chest first
  per the ADR 0070 fail-closed boundary, then `decapitated`, defeat goal,
  `started`/`defeated`/`bossEid`, and the relock flag cleared).
- A sealed-den safety net in `floor2ObjectiveTick`: an encounter that is
  `started && !defeated` whose boss is no longer `isLiveFamilyBoss` is latched
  defeated, so the doors reopen. It runs **after** the combat-event loop, and
  `isLiveFamilyBoss` is health-agnostic, so a normal kill (corpse still intact
  during death linger) always latches first with the boss's real death position.
- The victory-path reconciliation now routes through the same helper.

Observation: the softlock and its repair are reproduced deterministically in
`tests/integration/floor2-boss-den-containment.test.ts` against the real
`floor2ObjectiveTick` + `doorSystem` pipeline — before: `encounter.defeated`
false, `activeGoalId` true, both den doors `isLocked === 1` forever; after:
`defeated` true, `activeGoalId` false, both doors `isLocked === 0`. The test
fails on the pre-fix scenario file and passes on the fixed one. Chained headless
panel `--floor floor1 --seeds 11-20 --chain` stayed 10/10 wins before and after,
i.e. the change is neutral for runs that were never softlocked.

## Key Decisions Made

- **Fixed in `src/game/`, not `src/game/ai/`.** The issue prefers AI-runner
  fixes, but no runner change can open a locked door: this is real-game
  behavior and would softlock a human player identically. It is a lockout bug,
  not a balance change — nothing about damage, pacing, or drops moves.
- **Guard on "boss entity gone", not "boss dead".** Using `isLiveFamilyBoss`
  (component identity, health-agnostic) keeps the normal kill path
  authoritative, so boss-chest placement stays at the death position.
- **Left the vanish cause open.** The evidence proves the boss entity leaves the
  ECS without a `death` combat event, but not _which_ path removes it. The
  softlock guard is correct regardless, and post-fix runs now leave a greppable
  signature (`encounterDefeated:true` with `bossAlive:false`) for whoever chases
  the underlying despawn.

## What's Next / Blockers

- The next release sweep is the canonical re-measurement. Removing this bucket
  should move `floor1-chain` from 89.33% (134/150) to ~94.7% (142/150) if the
  remaining buckets are unchanged.
- Residual chain-leg buckets, for a future session: 5 timeouts where one family
  never reaches the 50-trash-kill den unlock (indices 22, 32, 55, 68, 87), and
  1 timeout (index 94) with `movementQuality.excludedPct` 58.2% and near-zero
  family kills, which looks like a reachability/lockout class worth its own
  repro-seed issue.
- Maintainer asked for a plan comment on the issue before coding. This sandbox
  has no issue-comment credentials (`gh auth status`: not logged in), so the
  plan was published in the PR description instead — same blocker as the
  2026-08-23 report-only-release-sweep-legs session.

## Retrospective

### Lessons Learned

- The release baseline payload is a far better diagnostic than a fresh sweep:
  `denBoss.families[*].final` carries door lock counts and `playerInDen`, so a
  softlock is visible directly from git without dispatching anything.
- Run index ≠ seed in the published legs. Shards run with 4 workers and results
  are concatenated in completion order, so failing indices only narrow a
  failure to its 10-seed shard. Reproducing a specific failure by seed is much
  more expensive than promoting the telemetry signature into a deterministic
  test.
- The sandbox mirror of `main` can be _behind_ the release commit the sweep ran
  on (the release sha was not fetchable here), so "this seed wins locally" is
  not evidence that the reported failure is gone.

### Mistakes Made

- Spent a chained-run cycle (~85s) trying to reproduce failure "seed 18" from
  chain-leg index 17 before checking the shard/worker ordering in
  `.github/workflows/deploy.yml` — the index→seed mapping does not hold. Early
  signal: `runs[i].startingWeapon` is `unknown` for the chained leg, i.e. the
  payload carries no seed identity at all.

### Opportunities for Future Improvement

- Record the seed on each run in the sweep payload (`runs[i].seed`). Every
  release-sweep investigation issue asks agents to reproduce specific failing
  runs, and today that identity is thrown away.
- Consider a headless-runner invariant that fails loudly when the player is
  inside a sealed den with no live boss, so this class ends a run with a
  diagnosis instead of a silent budget-exhaustion timeout.
