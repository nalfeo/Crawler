# Session Handoff: Nightly balance telemetry sweep — 2 eligible candidates, both blocked at the evaluation contract

## Date

2026-09-01

## Persona

Playtester

## Systems touched

ai-combat-balance, weapons, ci-policy

## Apples

2🍎 exact — telemetry analysis and a durable ledger; no runtime code changed.

## What Was Done

Executed issue #4027 (`balance: telemetry-driven nightly improvement sweep`) end to end
against its hard evidence gates. **No gameplay change was made and no implementation PR
was produced.** Two candidates cleared the candidate-eligibility gate and were ranked;
both were then blocked at the evaluation contract, because this session cannot dispatch
the canonical sweep required to accept or reject a treatment.

Honesty statement required by the issue: every number below comes from **headless
simulation telemetry only**. No release/tag data and no real-player telemetry were
consulted or implied, and no lookback window was invented.

### Baseline audit (facts)

Resolved from the git `baselines` branch (`index.json` newest entry → the full payload at
`by-sha/<commit>.json`), not from an Actions artifact.

| Field                      | Value                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline head SHA          | `099b6068b8c3f0157dbb376372a1e6144bd6680f`                                                                                                              |
| Commit subject             | Define Floor 3 pet-combat completion gate (#4016)                                                                                                       |
| Commit date (UTC)          | 2026-09-01T09:25:18Z                                                                                                                                    |
| Captured (UTC)             | 2026-09-01T10:38:17.399Z                                                                                                                                |
| Release run                | [`33494430865`](https://github.com/nalfeo/Crawler/actions/runs/33494430865) (run #1810)                                                                 |
| Payload                    | `baselines:by-sha/099b6068b8c3f0157dbb376372a1e6144bd6680f.json`                                                                                        |
| Fun report                 | `baselines:by-sha/099b6068b8c3f0157dbb376372a1e6144bd6680f.fun-report.json`                                                                             |
| `meta.sweep`               | `{ seeds: "1-50", kind: "winrate", revision: 2 }`                                                                                                       |
| `experiment.parameters`    | `{ floorId: "floor1", enemyDamageMultiplier: 1, maxFrames: 39600 }`                                                                                     |
| Behavior/config flags      | `forceWeapon: true`, `enemyDamageMultiplier: 1`, `chained: false` (floor1 leg); shipped defaults, no experimental flags                                 |
| Weapons (`dimensions`)     | sword, bow, baseball-bat, pistol, throwing-knife, fireball — 50 seeds each                                                                              |
| Legs and run counts        | `floor1` 300/300 (winRate 1.00) · `floor2` 141/150 (0.94) · `floor1-chain` 144/150 (0.96)                                                               |
| Per-run records in payload | 300 — **floor1 leg only**; the `floor2` and `floor1-chain` legs carry summary counts and no per-run records                                             |
| Fun report                 | 600 runs; overall 35.96, `gate.pass: false`; failing dimensions `challenge_balance` 3.57, `excitement` 24.31, `pacing` 32.10, `competence_growth` 34.66 |

The sweep formulation was read from the payload (`meta.sweep`, `legs`, `perWeapon`,
`records`), never assumed. The whole published payload was used; no shard, partial
artifact, local smoke, or hand-picked seed was used, and no runs were mixed across
baseline commits.

**Drift past the baseline commit:** `git rev-list --count 099b6068..origin/main` = **1**
commit — `aac3b77` "Implement Floor 6 run-scoped economy (#4017)". It is
gameplay-affecting (it touches `src/core/components.ts`, `src/core/world.ts`,
`src/core/spawners/pickups.ts`, and `src/core/systems/itemPickupSystem.ts`) even though
its behavior is scoped to Floor 6. Every claim below is therefore scoped to the baseline
commit `099b6068`, not to current main. This is the first analysis against this baseline,
so the "no new release baseline since the prior analysis" stop condition does not apply
(the prior analysis, 2026-08-20, terminated before any baseline was resolvable).

### Evaluation-contract capability check (verified, not assumed)

- `POST /repos/nalfeo/Crawler/actions/workflows/weapon-sweep.yml/dispatches` →
  **HTTP 403, body `Blocked by DNS monitoring proxy`**. Read-only GitHub traffic works.
- `gh auth status` → "not logged into any GitHub hosts".
- `weapon-sweep.yml` and `ai-sweep.yml` are both **dispatch-only**; no push, label, or
  comment trigger exists that a session could reach.
- The PR-tier CI legs are not a substitute: `test-headless-multifloor` runs
  `floor1-chain --seeds 1-10` and `floor2 --seeds 1-15`, which the issue explicitly
  rejects ("never substitute 10-seed indicative results") and which do not match the
  baseline's 6-weapon × 50-seed formulation.

Therefore the contract's own stop condition applies: _inability to run an independent
canonical sweep ⇒ no implementation, no PR_. **0 evaluation attempts were made**
(max 3/candidate never reached), and nothing was tuned against named seeds.

## Durable ledger

| #   | Rank / name                                   | Measured symptom (baseline `099b6068`)                                                                                                                                                                                                                                             | Causal evidence                                                                                                                                                                                                                                                                                            | Production path                                                                                                                                                                  | Enabling config/flag                                                                      | Hypothesis                                                                                                           | Exact change | Baseline metric                                                                | Post metric  | Run / artifact URL                                                            | Verdict                | Rationale                                                                                                                                                                            |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Floor-1 starter-weapon clear-time spread      | Mean `gameTimeSec` by starting weapon: fireball 258.2, pistol 274.1, throwing-knife 285.6, bow 308.1, sword 330.6, baseball-bat 378.1 (spread 119.9 s ≈ 46% of fastest). Mean `finalLevel` 7.20 (pistol) → 9.48 (baseball-bat), n=50 each.                                         | The sweep fixes `forceWeapon: true` and varies only `dimensions.startingWeapon`; all other parameters are identical across the 300 records, so the spread is attributable to the starter weapon by the experiment's own design. Mean `combat.totalKills` moves with it (97.8 pistol → 145.4 baseball-bat). | `src/shared/data/floors/floor1.manifest.json` `starterWeapons` → `getFloor1StarterWeaponPool` → `pickStarterChoices` → `selectFloor1StarterWeapon` (`src/game/floorScenario.ts`) | Shipped default manifest; no flag. All six IDs appear in the baseline's `perWeapon` rows. | Narrowing per-weapon time-to-clear tightens pacing (fun `pacing` 32.10) without touching the Floor-1 win-rate floor. | none         | per-weapon mean `gameTimeSec` / `finalLevel` above; leg winRate 1.00 (300/300) | not measured | [run 33494430865](https://github.com/nalfeo/Crawler/actions/runs/33494430865) | **Blocked**            | Eligible, ranked 1. No canonical sweep can be dispatched from this session (403 at the sandbox proxy), so it cannot be accepted or rejected; the contract forbids shipping it.       |
| 2   | Floor-1 challenge floor is effectively absent | `winRate` 1.00 (300/300), `totalTrueLosses` 0, `totalSlowVictories` 0; mean `minHealthPercent` 0.8504, mean `closeCallCount` 0.0033, mean `lowHealthCount` 0.0633. Fun report `challenge_balance` 3.57 vs `min_dimension` 55, `survivability_variance` 0.11 vs the 0.14–0.45 band. | Both the leg aggregate and the fun report's `criteria` are computed from these same 300 runs. Damage attribution is only partial (see row 5), so **no specific enemy, room, encounter, or attack is claimed**.                                                                                             | Floor 1 default scenario, exercised by every baseline run                                                                                                                        | Shipped defaults, `enemyDamageMultiplier: 1`                                              | A bounded difficulty increase raises `challenge_balance` and `survivability_variance` toward their bands.            | none         | as above                                                                       | not measured | [run 33494430865](https://github.com/nalfeo/Crawler/actions/runs/33494430865) | **Blocked**            | Eligible, ranked 2, and higher-risk: AGENTS.md rule #12 requires 90%+ of Floor-1 seeds to reach a win, so any treatment needs the canonical sweep this session cannot run.           |
| 3   | Unspent Floor-1 gold                          | Mean `goldEconomy.earnedTotal` 852.5, `unspentAtExit` 312.4, `unspentSpendableFraction` 0.3689 (p10/p50/p90 unspent = 220/302/414); mean `distinctPurchases` 2.00.                                                                                                                 | `vendors.decisions` attributes the non-purchases to the agent's own policy, not to price or stock: 168 `declined \| no-weapon-class-switch-this-run` and 3 `abandoned \| deficit-unfarmable-in-budget`, against 879 purchases.                                                                             | `floor1-merchant`, `floor1-spell-broker` (visited in all 300 runs)                                                                                                               | Shipped vendors                                                                           | —                                                                                                                    | none         | as above                                                                       | n/a          | same artifact                                                                 | **Rejected**           | The recorded cause is the headless BT agent's purchase policy, not pricing or stock. Repricing would tune the game around an agent decision — AI/telemetry work, not balance tuning. |
| 4   | Reward boxes left unopened                    | Mean `equipmentPlayability.unopenedRewardBoxes` 2.00; 299/300 runs end with ≥1. `goldSpentOnEquipment` 0 in 300/300; `equippedGeneratedCount` > 0 in only 99/300.                                                                                                                  | `collectEquipmentPlayabilityMetrics` sums three distinct sources (unclaimed achievement rewards + unclaimed boss chests + `pendingPresentations`); the artifact records only the composite, so which source dominates is unknown.                                                                          | `src/game/ai/headless-runner-invariants.ts`; the matching invariant is enforced only for `floor2` + `settlementReturnRouting`, so Floor 1 does not fail on it                    | Shipped defaults                                                                          | —                                                                                                                    | none         | as above                                                                       | n/a          | same artifact                                                                 | **Rejected**           | Missing attribution ⇒ telemetry/investigation, not tuning. Split the composite metric into its three components before anyone proposes a change.                                     |
| 5   | Unattributed damage taken                     | `combat.damageTakenBySource` totals across 300 runs: rat 13,995 · rat-slime 13,542 · slime 9,801 · slime-mini 1,785 · **unknown 2,392** (≈5.9%). `killsByType` records only `rat` and `slime` despite `slime-mini`/`rat-slime` dealing damage.                                     | The artifact itself labels the bucket `unknown`, and the kill/damage taxonomies disagree.                                                                                                                                                                                                                  | n/a                                                                                                                                                                              | n/a                                                                                       | —                                                                                                                    | none         | as above                                                                       | n/a          | same artifact                                                                 | **Rejected**           | The issue forbids claiming an enemy/encounter/damage source the artifact does not record. This is a telemetry gap to close, not a balance candidate.                                 |
| 6   | Floor-2 and Floor-1-chain losses              | `floor2` 141/150 (9 losses), `floor1-chain` 144/150 (6 losses).                                                                                                                                                                                                                    | None available: the payload stores these legs as `{winRate, totalWins, totalRuns}` only. No per-run records, aggregates, or failure reasons are published for them.                                                                                                                                        | unknown from the artifact                                                                                                                                                        | unknown from the artifact                                                                 | —                                                                                                                    | none         | leg counts above                                                               | n/a          | same artifact                                                                 | **Rejected**           | No measured aggregate fields and no attribution ⇒ fails the candidate gate outright. Publishing per-run records for the non-floor1 legs would make these losses analysable.          |
| 7   | Floor-1 XP left on the ground                 | Mean `lootEfficiency.xpRatio` 0.7266 (mean `xpSpawned` 220.6 vs `xpCollected` 164.0); mean `goldRatio` 0.8847.                                                                                                                                                                     | Mean `aiTelemetry.decisionStateMs` share across the 300 records: EXPLORE 70.3%, ENGAGE 28.5%, **COLLECT 0.89%** — the shortfall tracks the agent's collection behaviour, not a drop-rate setting.                                                                                                          | n/a (agent behaviour)                                                                                                                                                            | Shipped defaults                                                                          | —                                                                                                                    | none         | as above                                                                       | n/a          | same artifact                                                                 | **Rejected**           | Attributable to the headless agent's loot sweep, not to XP tuning. Changing XP values to compensate would tune the game around the runner (rule #12 in spirit).                      |
| 8   | Floor-1 spawner arenas never fire             | `spawnerArenas.total` 0 and `triggered` 0 in all 300 runs.                                                                                                                                                                                                                         | The feature records zero instances in the baseline, so it was not enabled/reachable on the floor the baseline covers.                                                                                                                                                                                      | not reachable in baseline                                                                                                                                                        | not enabled in baseline                                                                   | —                                                                                                                    | none         | as above                                                                       | n/a          | same artifact                                                                 | **Rejected**           | Dormant in the baseline ⇒ explicitly ineligible under the candidate gate (no proof the feature was enabled).                                                                         |
| 9   | Evaluation path unavailable                   | Both eligible candidates (rows 1–2) are unshippable.                                                                                                                                                                                                                               | `POST .../weapon-sweep.yml/dispatches` → 403 `Blocked by DNS monitoring proxy`; `gh` unauthenticated; `weapon-sweep.yml`/`ai-sweep.yml` are dispatch-only; PR CI legs are 10/15 seeds.                                                                                                                     | n/a                                                                                                                                                                              | n/a                                                                                       | —                                                                                                                    | none         | n/a                                                                            | n/a          | n/a                                                                           | **Blocked (terminal)** | Evaluation contract: inability to run an independent canonical sweep ⇒ no implementation and no PR. Terminal no-PR closure taken.                                                    |

**Verdict: 2 eligible candidates, 0 evaluation attempts, no gameplay change, no
implementation PR.** The mandatory human-approval gate is not engaged because no gameplay
PR exists; nothing was tuned, and no seed-level or shard-level data was used to
manufacture a candidate.

## Key Decisions Made

- **Refused to ship an unmeasured treatment.** Rows 1 and 2 are real, evidence-backed
  candidates, but the contract's accept/reject step is unreachable from this session.
  Landing either one on local smoke evidence would have violated the evaluation contract
  and AGENTS.md rule #11.
- **Refused to fill the quota.** Rows 3–8 are all measurable symptoms, and every one of
  them fails a specific clause of the candidate gate (agent-policy attribution, composite
  metric, `unknown` source, absent per-run records, dormant feature). They stay visible in
  the ledger as rejections rather than being promoted to reach three candidates.
- **Kept the ledger's rejected rows attributed, not summarised.** Each rejection names the
  exact field and value that disqualified it, so a future session with dispatch rights can
  re-open row 1 or 2 without re-deriving the analysis.
- **Did not invent an evaluation path.** Substituting the 10/15-seed report-only PR CI legs
  for the canonical sweep is explicitly forbidden by the issue, and building an on-demand
  canonical-sweep trigger is a separate, reviewable automation change — not something to
  bolt on inside a no-PR closure.

## What's Next / Blockers

- **Issue #4027 must be closed with this rationale.** This session has no issue-comment or
  issue-close credentials (all GitHub write endpoints return
  `403 Blocked by DNS monitoring proxy`), so this PR carries `Closes nalfeo/Crawler#4027`
  and this ledger; merging it closes the issue and unblocks the next nightly filing.
- **The recurring blocker is the evaluation path, not the baseline.** The 2026-08-20 session
  fixed baseline resolution (that gate now passes cleanly). The remaining gap — a Copilot
  session cannot start a canonical sweep — will terminate every future nightly run at row 9
  until a dispatch path a session can actually reach exists (for example a workflow
  triggered by a committed sweep-request file on a session branch, publishing a
  release-comparable aggregate).
- **Two cheap telemetry fixes would unlock three more ledger rows:** publish per-run records
  for the `floor2` and `floor1-chain` legs (row 6), split `unopenedRewardBoxes` into its
  three components (row 4), and label the `unknown` damage source (row 5).

## Retrospective

### Lessons Learned

- The release baseline payload is **floor1-only at the record grain**: `legs.floor2` and
  `legs['floor1-chain']` carry three summary numbers each. Any analysis that needs failure
  attribution on those legs is dead on arrival, so check `records`/`dimensions` before
  planning work against a non-floor1 leg.
- `vendors.decisions[].outcome` is a four-value field (`purchased`/`wanted`/`declined`/
  `abandoned`) where `wanted` is an **intent** record that usually converts (129 of 132
  became purchases). Counting "non-purchase" outcomes naively overstates declines by ~2×.
- `equipmentPlayability` is only enforced as an invariant on `floor2` with
  `settlementReturnRouting`; on Floor 1 the same fields are reported and ignored. A metric
  that looks like a failing invariant may simply be out of the invariant's scope.
- The sandbox blocks GitHub **writes** but not reads, and `git fetch origin baselines` works
  — durable git-persisted telemetry is reachable where the Actions API is not.

### Mistakes Made

- Read `d.legs` as an array on first inspection and got `TypeError: d.legs is not iterable`;
  it is an object keyed by leg id. Early signal: the `index.json` entry already shows `legs`
  as an object with named keys — read the index before parsing the payload.
- Initially keyed the vendor-decision tally on `dec.action || dec.decision`, both undefined,
  which produced a table of `?/reason` rows. Early signal: every key rendered with a literal
  `?` prefix. Print one raw record before aggregating a field you have not seen.
- Nearly counted the 233 "affordable non-purchase" decisions as evidence of a gold-sink
  shortfall before noticing that `wanted` rows are intents that later convert.

### Opportunities for Future Improvement

- Add a session-reachable trigger for a release-comparable canonical sweep. Until that
  exists, this nightly issue can only ever produce ledger rows, never a treatment.
- Have the release sweep publish per-run records for every leg it summarises, not just
  `floor1`; three of the eight rejections above trace to missing per-leg detail.
- The fun report already marks `unsafe_combat_uptime` and `meta_progression` as
  `unmeasured`; closing those two would give the challenge-balance candidate (row 2) a
  sharper target than `challenge_balance` alone.
