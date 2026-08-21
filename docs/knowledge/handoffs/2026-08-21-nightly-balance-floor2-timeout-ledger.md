# Session Handoff: Nightly balance sweep — Floor-2 timeout attribution, terminal no-PR outcome

## Date

2026-08-21

## Persona

Playtester

## Systems touched

ai-combat-balance, quests, ci-policy

## Apples

2🍎 exact

## What Was Done

Executed issue [#3210](https://github.com/nalfeo/Crawler/issues/3210)
(`balance: telemetry-driven nightly improvement sweep`) end to end against its hard
evidence gates. **No gameplay change was made and no gameplay PR was opened.** The
baseline gate passed for the first time since it was repointed at the `baselines`
branch, so this session actually reached candidate analysis — but the evaluation
contract's "inability to run an independent canonical sweep ⇒ no implementation/PR"
still terminates the session, because a Copilot sandbox cannot dispatch a workflow.

This handoff is the durable ledger required by the issue.

### Baseline resolution (facts, read from the git `baselines` branch)

Resolved by taking the newest entry of `baselines/index.json` and reading the whole
payload at `by-sha/<commit>.json`. No shards, no partial artifacts, no local smoke,
no hand-picked seeds, and no runs mixed across baseline commits were used.

| Field               | Value                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Baseline head SHA   | `8b56d574ffb4f352416e99c7c330600c66b315d9`                                                                                                 |
| Commit subject      | `chore(assets): reconcile queued sprite edits (2 art paths) (#3202)`                                                                       |
| Commit date (UTC)   | 2026-08-21T06:55:07Z                                                                                                                       |
| Sweep `runAt` (UTC) | 2026-08-21T07:23:07.786Z (`experiment.id` `ai-sweep-1787296987786`)                                                                        |
| Captured (UTC)      | 2026-08-21T07:58:42.299Z                                                                                                                   |
| Release run         | [run 32456957746](https://github.com/nalfeo/Crawler/actions/runs/32456957746) (run number 1609)                                            |
| `meta.sweep`        | `{ "seeds": "1-50", "kind": "winrate", "revision": 2 }`                                                                                    |
| Payload             | [`baselines/by-sha/8b56d574….json`](https://github.com/nalfeo/Crawler/blob/baselines/by-sha/8b56d574ffb4f352416e99c7c330600c66b315d9.json) |
| Fun report          | `overallFunScore` 35.92, `gatePass` false                                                                                                  |

Sweep shape, read out of the payload itself rather than assumed:

| Leg            | `floorId` / chained   | Weapons                                                             | Seeds  | Runs | Wins | Win rate   |
| -------------- | --------------------- | ------------------------------------------------------------------- | ------ | ---- | ---- | ---------- |
| `floor1`       | `floor1`, not chained | sword, bow, baseball-bat, pistol, throwing-knife, fireball (forced) | 1–50   | 300  | 300  | **1.000**  |
| `floor2`       | floor 2               | seed-selected (not recorded per run)                                | 1–150¹ | 150  | 41   | **0.2733** |
| `floor1-chain` | floor 1 → 2, chained  | seed-selected (not recorded per run)                                | 1–150¹ | 150  | 52   | **0.3467** |

Behaviour/config flags recorded in the payload: `forceWeapon: true`,
`enemyDamageMultiplier: 1`, `chained: false` and `experiment.parameters.maxFrames:
39600` for the `floor1` leg; `schemaVersion: "crawler.experiment.v1"`. The `floor2`
and `floor1-chain` legs record only `winRate`/`totalWins`/`totalRuns`/`runs`, so
their frame budget is **not** recorded — every `floor2` timeout terminates at exactly
`totalFrames: 72001`, from which a 72 000-frame (1200 s @ 60 fps) budget is
_inferred_, not read. ¹ Seed identity is likewise not recorded per run for the two
report-only legs; only the run count is.

Honesty statement required by the issue: this is **headless simulation telemetry
only**. No release/tag data and no real-player telemetry were consulted or implied,
and no lookback window was invented.

### Distance from current main

`main` is `a82b2d9b` (2026-08-21T08:25:40Z), **2 commits** past the baseline commit:

| Commit     | PR    | Gameplay-affecting?                                                                                                                  |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `25f369a7` | #3027 | No (claimed gameplay-neutral perf: collision size lookups in the sim hot path)                                                       |
| `a82b2d9b` | #3033 | **Yes** — Floor 3 companion entity model + team-targeted AI prepass; touches `src/core/damageSystem.ts`, `src/game/enemyAISystem.ts` |

Every measurement and claim below is scoped to `8b56d574` and is **not** re-validated
against `a82b2d9b`.

This baseline is newer than the one analysed by the previous nightly (#3185, which
terminated on the baseline gate itself), so this is not duplicate work.

### Facts measured from the baseline payload

Separated deliberately from hypotheses and from source inspection.

1. **Floor 1 is at the ceiling.** 300/300 wins, every one of the six forced weapons
   50/50, `totalSlowVictories: 0`, `totalTrueLosses: 0`.
2. **Floor 2 fails by timeout, not by death.** `floor2` outcomes: 41 victory,
   **99 timeout**, 8 death, 2 stalled. `floor1-chain`: 52 victory, **87 timeout**,
   8 death, 3 stalled. All 150 `floor1-chain` runs record `finalFloor: 2`, so the
   chain leg's win rate is a Floor-2 completion rate, never a Floor-1 failure.
3. **Den bosses are almost never the blocker.** Across both Floor-2 legs, 1009 dens
   were unlocked, 1009 entered, 1009 encounters started and **986 defeated**
   (97.7 % of started encounters).
4. **Den unlock cost is exactly 50 family trash kills.** Of the 1009 unlocks,
   1007 recorded `trashKillsAtDenUnlock: 50` and 2 recorded 51 (same-frame overkill).
5. **Half the Floor-2 timeouts die mid-grind.** 50 of the 99 `floor2` timeouts had
   not cleared all four dens; their median total family trash kills is **159** of the
   200 required, against a victory median of 210. In `floor1-chain`, 54 of 87
   timeouts were mid-grind at a median of **197** of 200.
6. **The other half clear every den and still never exit.** 49 of the 99 `floor2`
   timeouts defeated all four dens and accepted `floor2-leave-floor`, yet every one
   records `exitCompleted: false`. Their median post-final-den time is **359 617 ms**
   versus a victory median of **132 283 ms** and a victory maximum of **436 317 ms**;
   **12 of the 49** spent longer in the exit phase than the slowest victory did.
   (33 of the 87 `floor1-chain` timeouts show the same signature.)
7. **Lethality is diffuse.** The 8 `floor2` death runs took 4640 damage across
   27 distinct `damageTakenBySource` ids; the largest single contributor
   (`raccoon-bottle-rocketeer`) is 13.4 %.

### Source inspection (kept separate from telemetry)

`src/shared/data/quests.floor2.dens.json` at `8b56d574` defines the den-unlock
archetype `thin-the-ranks` with `"kind": "killTargets"`, `"killTarget": 50`. This
file is byte-identical at current `main`. Fact 4 is what proves that archetype — and
not one of the sibling archetypes (`steal-ledger`, `win-favor`, `sabotage-still`,
`bring-tribute`) — was the enabled unlock path in the baseline runs.

## Durable ledger

Max 9 rows; rejected and blocked rows kept visible. "Post metrics" is empty on every
row because **no treatment was evaluated** — see row 5.

| #   | Rank / name                                                           | Measured symptom (baseline `8b56d574`)                                                                                                                                                                                   | Causal evidence                                                                                                                                                                                                                          | Production path                                                                                                                                             | Enabling config / flag                                                                   | Hypothesis                                                                                          | Exact change | Baseline metrics                                                                      | Post metrics | Run / artifact URLs                                                                                                                                                                                              | Verdict                                                                                                                                                                               |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **1 — Floor-2 den-unlock kill cost (`thin-the-ranks` killTarget 50)** | 50 of 99 `floor2` timeouts (33 % of the leg) end mid-grind at a median 159/200 required family trash kills; 54 of 87 `floor1-chain` timeouts at a median 197/200 (facts 2, 5)                                            | 1007/1009 den unlocks fire at exactly 50 kills (fact 4); 986/1009 started den encounters are defeated, so the boss fight is not the blocker (fact 3)                                                                                     | Floor-2 den-unlock quests `floor2-den-<family>-unlock`, recorded as accepted at t ≈ 16.7 ms in every baseline Floor-2 run; served by the shipped quest pack | `src/shared/data/quests.floor2.dens.json` → archetype `thin-the-ranks`, `killTarget: 50` | Lowering the kill target returns budget to the exit phase and converts mid-grind timeouts into wins | none         | `legs.floor2.winRate` 0.2733 (41/150); `legs['floor1-chain'].winRate` 0.3467 (52/150) | —            | [baseline payload](https://github.com/nalfeo/Crawler/blob/baselines/by-sha/8b56d574ffb4f352416e99c7c330600c66b315d9.json), [release run 32456957746](https://github.com/nalfeo/Crawler/actions/runs/32456957746) | **Blocked** — passes every candidate-eligibility gate, but row 5 makes an independent canonical sweep impossible, so no change was made                                               |
| 2   | 2 — Floor-2 exit phase never completes after the final den            | 49/99 `floor2` timeouts cleared all four dens, accepted `floor2-leave-floor`, and still record `exitCompleted: false`; median 359 617 ms of exit-phase time, 12 of them beyond the slowest victory's 436 317 ms (fact 6) | The artifact records **no** exit route, exit-room-reached, or path-failure field, so nothing in the telemetry attributes the failure                                                                                                     | Floor-2 `floor2-leave-floor` quest / floor exit                                                                                                             | unknown — not recorded                                                                   | Unproven; the excess time strongly suggests exit routing rather than budget, but that is inference  | none         | same as row 1                                                                         | —            | same as row 1                                                                                                                                                                                                    | **Rejected** — missing causal attribution ⇒ telemetry/investigation, not tuning (see "What's Next")                                                                                   |
| 3   | 3 — Floor-1 difficulty / starter-weapon balance                       | No symptom: 300/300 wins, all six weapons 50/50, 0 slow victories (fact 1)                                                                                                                                               | n/a                                                                                                                                                                                                                                      | Floor 1                                                                                                                                                     | `forceWeapon: true`, `enemyDamageMultiplier: 1`, `maxFrames: 39600`                      | n/a                                                                                                 | none         | `winRate` 1.000 (300/300)                                                             | —            | same as row 1                                                                                                                                                                                                    | **Rejected** — ceiling effect: the named canonical metric has zero headroom, so no treatment could be shown to help; rule #12's ≥90 % target is already exceeded                      |
| 4   | — Floor-2 lethality / enemy damage                                    | Only 8/150 `floor2` runs end in death (5.3 %) (fact 2)                                                                                                                                                                   | Damage in those 8 runs is spread over 27 distinct sources, largest 13.4 % (fact 7)                                                                                                                                                       | Floor-2 combat                                                                                                                                              | `enemyDamageMultiplier: 1`                                                               | n/a                                                                                                 | none         | 8 deaths / 150 runs                                                                   | —            | same as row 1                                                                                                                                                                                                    | **Rejected** — no dominant attributable source; the issue forbids naming an enemy/attack the artifact does not isolate                                                                |
| 5   | — Evaluation-contract infrastructure                                  | The evaluation contract requires >10 runs via GitHub workflow dispatch; this session cannot dispatch one                                                                                                                 | Every GitHub write endpoint answers `Blocked by DNS monitoring proxy` from the agent sandbox (verified against `POST /repos/nalfeo/Crawler/actions/workflows/weapon-sweep.yml/dispatches`); the available GitHub MCP tools are read-only | n/a                                                                                                                                                         | n/a                                                                                      | n/a                                                                                                 | none         | n/a                                                                                   | —            | n/a                                                                                                                                                                                                              | **Blocked** — no label, comment, or `repository_dispatch` trampoline exists in `.github/workflows`, so "inability to run an independent canonical sweep ⇒ no implementation/PR" fires |

**Verdict: 1 eligible candidate, 0 evaluation attempts, no gameplay PR.** Nothing was
tuned. No seed-level or shard-level data was used to manufacture a candidate, and no
named seed was tuned against.

## Key Decisions Made

- **Refused to ship candidate 1 unmeasured.** It is the only row that clears every
  candidate-eligibility gate (exact aggregate values, telemetry-backed attribution,
  production reachability on a floor the baseline covers, proof the archetype was
  enabled, a named canonical metric). Shipping it on a hypothesis — or on a local
  smoke run — would violate the evaluation contract and rules #11/#12.
- **Routed candidate 2 to investigation, not tuning.** It is the larger symptom by
  run count, but the artifact carries no field that attributes it. Guessing at a
  cause and tuning around it is exactly what the candidate gate forbids.
- **Rejected Floor 1 on a ceiling argument.** A 100 % canonical metric cannot
  demonstrate an improvement, only a regression, so no Floor-1 candidate is
  measurable under this contract regardless of how attractive it looks.
- **Kept this session documentation-only.** The remaining blocker is a CI dispatch
  capability, not a shortage of ideas; designing a branch-scoped release-sweep
  workflow is a real DevOps change with its own security surface and belongs in its
  own reviewed session, not bolted onto a balance analysis.

## What's Next / Blockers

1. **Issue #3210 closes with this ledger.** This session cannot post issue comments
   or close issues (all GitHub write endpoints are blocked at the sandbox proxy), so
   the accompanying PR carries `Closes nalfeo/Crawler#3210`; merging it closes the
   issue and unblocks the next nightly filing.
2. **Blocker for every future nightly: no agent-reachable canonical sweep.**
   `weapon-sweep.yml`, `ai-sweep.yml` and `optional-purchases-sweep.yml` are
   `workflow_dispatch`-only, and the release sweep runs only from `deploy.yml` on
   `main`. There is no label-, comment-, or `repository_dispatch`-triggered path, so
   no Copilot session can ever satisfy the evaluation contract. A DevOps session
   should add a **branch-scoped balance sweep** reachable from a committed request
   file (for example `on: push` filtered to a `.github/sweep-requests/*.json` path on
   `copilot/**` branches) that runs the `RELEASE_SWEEP_LEGS` matrix from
   `scripts/agent/perf/sweep-legs.ts` and uploads the aggregate. Note that
   `weapon-sweep.yml` alone is **not** sufficient: it is Floor-1-only, and every
   eligible candidate here lives on Floor 2. Until that exists, this issue will
   terminate the same way every night.
3. **Follow-up investigation for candidate 2.** Add exit-phase telemetry to the
   Floor-2 headless runner (exit room reached, route computed/failed, time from
   `floor2-leave-floor` acceptance to exit) so the 49-run signature can be attributed
   next time. That is a `game-ai-engineer`/`qa-engineer` task, not a tuning task.
4. **Candidate 1 stays queued.** Once (2) lands, the first canonical A/B to run is a
   Floor-2 leg at reduced `thin-the-ranks` `killTarget` against the then-current
   release baseline, identical seeds/flags/limits, one change at a time.

## Retrospective

### Lessons Learned

- The `baselines` branch payload is ~26 MB; `git show origin/baselines:by-sha/<sha>.json`
  into a temp file and analysing with `node -e` is far cheaper than trying to read it
  through file-viewing tools.
- The report-only legs (`floor2`, `floor1-chain`) carry the interesting per-run
  telemetry (`floor2Progression`, `denBoss`, `quests.questLogCompletions`) while the
  blocking `floor1` leg carries only flat per-run `metrics`. The richest balance
  signal in the release baseline is in the legs that never block CI.
- Frame budgets are not recorded per leg. Every `floor2` timeout landing on exactly
  `totalFrames: 72001` is the only way to recover the budget, and that is an
  inference — the ledger has to say so.
- "Timeout" dominating a leg does **not** by itself mean the floor is too hard. Half
  the timeouts here had already beaten every boss, which points at routing rather
  than difficulty and flips the correct remedy from tuning to instrumentation.

### Mistakes Made

- Ran `git checkout -q <baseline-sha> -- .` to inspect a data file at the baseline
  commit, which staged a full revert of the working tree to that commit. Early
  signal: `git status --short` immediately showed a dozen `M` entries for files this
  session never touched. Recovered with `git reset HEAD -- . && git checkout -- .`.
  Use `git show <sha>:<path>` to read a file at another commit — never
  `git checkout <sha> -- .`.
- Initially reported "every unlocked den was defeated" from the `floor2` timeout
  subset alone; across both legs it is 986/1009, not 1009/1009. Sub-slicing before
  computing the population figure produced a claim that was 2.3 % wrong.

### Opportunities for Future Improvement

- The nightly filer could stamp the baseline→main commit delta (and which of those
  commits are gameplay-affecting) into the issue body, since every session recomputes
  it identically.
- The release sweep could record, per leg, the frame budget and seed panel it
  actually used, so sessions stop inferring budgets from `totalFrames` clustering.
- Two nightlies in a row have now terminated on infrastructure rather than on
  evidence. The filer should arguably refuse to file a fresh balance issue while no
  agent-reachable evaluation path exists, and file a single DevOps issue instead —
  otherwise the nightly burns a session a day producing the same blocked ledger.
