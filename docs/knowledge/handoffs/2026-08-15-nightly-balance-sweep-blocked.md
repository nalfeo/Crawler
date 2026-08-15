# Session Handoff: Nightly Balance Sweep — Blocked on Baseline Eligibility

## Date

2026-08-15

## Persona

Playtester

## Systems touched

ai-combat-balance

## Apples

1🍎 exact

## What Was Done

Executed the telemetry-driven nightly balance sweep (issue #2961) as an
investigation session. Every hard evidence gate was run in order and the work
stopped at the first failure instead of manufacturing a tuning change. No
gameplay code, tuning data, or configuration was modified, so no implementation
PR exists to observe in a runtime artifact.

### Baseline eligibility — FAILED (three independent reasons)

Candidate baseline: the latest successful **current-main** `weapon-sweep.yml`
run.

| Field            | Value                                                                        |
| ---------------- | ---------------------------------------------------------------------------- |
| Run ID           | 31744723997 (`project:sweep-results-viewer runId=31744723997`)               |
| UTC timestamp    | 2026-08-13T21:14:21Z                                                         |
| Head SHA         | `5ea6cb36f0253d362abc7ba47a5ea6d0a1594d4a` (branch `main`)                   |
| Seed range/count | seeds 1–30, **30 seeds/weapon** (4 shards/weapon, from the job matrix names) |
| Weapons          | sword, bow, baseball-bat, pistol, throwing-knife, fireball                   |
| FINAL aggregates | all six present, unexpired                                                   |

1. **Seed count.** The issue admits 100 seeds/weapon only. This run is 30
   seeds/weapon, evidenced by the sharded job names
   (`weapon-sweep (sword, 0, 1,5,9,13,17,21,25,29, 0)` … seeds stop at 30).
2. **Staleness.** `5ea6cb36` is 32 commits behind current main (`38c1e873`).
   Gameplay-affecting commits landed after it and change headless-sim behavior:
   `cbafb339` (retreat-threat recovery, `src/game/ai/bt-ai-provider.ts`),
   `2b241008` (boss-arena add targeting, same file), `4f35270a` (optional
   purchases defaulted on, `src/game/ai/headless-runner.ts` +
   `optional-purchases.ts`), `8f25e170` (complete-floor run budgets,
   `src/game/ai/headless-runner.ts`, `floor-run-budget.ts`,
   `src/shared/data/floors/*.manifest.json`), `0f969da8` (playtest personas).
   The issue requires a fresh canonical sweep in that situation.
3. **Duplicate.** Run 31744723997 was already consumed as the matched-main
   comparison arm by the 2026-08-13 wounded-retreat-arbitration session
   (`docs/knowledge/handoffs/2026-08-13-wounded-retreat-arbitration.md`). No new
   eligible aggregate run has been produced since that analysis, which is itself
   a stop condition.

### Evaluation contract — BLOCKED

The remedy for a stale baseline is a fresh canonical GitHub Actions
`weapon-sweep.yml` dispatch at current main with 100 seeds/weapon. This session
has no GitHub write credentials (`gh auth status`: not logged in; only read-only
GitHub tooling is available), so it cannot dispatch the canonical sweep, and the
contract forbids substituting local smoke runs, individual shards, hand-picked
seeds, or 10-seed indicative results. Per the contract, inability to run an
independent canonical sweep means no implementation and no PR.

### Candidates

Zero. Candidate eligibility requires exact measured aggregate fields at an exact
eligible baseline SHA plus telemetry-backed causal attribution. With no eligible
baseline, every candidate would fail attribution before ranking, so none were
proposed. The quota was deliberately not filled.

### Honest telemetry statement

All data referenced here is headless simulation output from `weapon-sweep.yml`.
It is not release telemetry and not real-player telemetry. No release/tag
lookback was performed or invented.

## Durable ledger

| #   | Name                                      | Measured symptom                                                  | Causal evidence                                                                                         | Production path | Enabling config/flag | Hypothesis | Exact change | Baseline metrics                                              | Post metrics | Run/artifact URLs                                                                                                          | Verdict                 | Rationale                                                                                         |
| --- | ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------- | -------------------- | ---------- | ------------ | ------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| 0   | Baseline intake (prerequisite, not a fix) | Latest current-main sweep is 30 seeds/weapon and 32 commits stale | Job matrix seeds 1–30; gameplay commits `cbafb339`, `2b241008`, `4f35270a`, `8f25e170` after `5ea6cb36` | n/a             | n/a                  | n/a        | none         | run 31744723997, `5ea6cb36`, seeds 1–30, six FINAL aggregates | none         | `project:sweep-results-viewer runId=31744723997` (secondary: <https://github.com/nalfeo/Crawler/actions/runs/31744723997>) | Blocked                 | Fails 100-seeds/weapon, fails current-main freshness, already consumed by the 2026-08-13 analysis |
| 1   | (no candidate)                            | —                                                                 | —                                                                                                       | —               | —                    | —          | —            | —                                                             | —            | —                                                                                                                          | Rejected before ranking | No eligible baseline SHA exists, so no candidate can carry telemetry-backed attribution           |

## Key Decisions Made

- Treated the seed-count, freshness, and duplicate findings as three independent
  disqualifications rather than looking for the most forgiving reading of one.
- Did not fill the three-candidate quota. Zero eligible candidates is an
  explicitly valid outcome, and proposing untraceable tuning would violate the
  candidate-eligibility gate and rule #11.
- Did not run a local sweep to substitute for the canonical GitHub run. Local
  smoke can neither accept nor reject under the evaluation contract, so running
  it would produce evidence that is inadmissible by construction.
- Recorded the ledger as a committed handoff because the session cannot post
  issue comments; the durable record must survive the session either way.

## What's Next / Blockers

**Terminal no-PR outcome — issue #2961 requires closure with a final
rationale/ledger comment.** This session has read-only GitHub access and cannot
comment on or close the issue, so an actor with `issues: write` must post the
ledger above and close #2961. Leaving it open blocks every future nightly run
from filing a fresh issue against newer telemetry.

To unblock the next attempt: dispatch `weapon-sweep.yml` on current `main` with
`seed_count=100` and the default weapon list, wait for all six FINAL aggregates,
then re-run this analysis against that run.

## Retrospective

### Lessons Learned

- The nightly balance issue's baseline gate is stricter than the default
  weapon-sweep dispatch habit in this repo: recent runs have used 30 seeds for
  PR-comparison work, so the "latest successful main run" is routinely
  ineligible for nightly balance intake even when it is fresh and complete.
- Checking baseline staleness needs a real merge-base diff, not a timestamp
  glance. `git fetch --unshallow` first — the session clone is shallow and
  `git log <baseline>..origin/main` silently has nothing to say without it.
- Verify seed count from the sharded job names rather than from a prior
  handoff's prose; the job matrix is the artifact-level fact.

### Mistakes Made

- Initially treated the prior session's prose ("seeds 1-30") as sufficient
  evidence of the seed count before confirming it against the run's job matrix.
  Early signal: any eligibility claim sourced from a narrative document rather
  than from the run/artifact itself should be re-derived from the API.

### Opportunities for Future Improvement

- The nightly filer could pre-resolve baseline eligibility (latest main
  `weapon-sweep.yml` run with six FINAL aggregates at 100 seeds/weapon, not
  older than the newest gameplay commit) and either embed the eligible run ID in
  the issue body or skip filing entirely. That would turn today's manual
  three-gate check into a deterministic precondition and stop nightly issues
  from being opened against provably ineligible telemetry.
- Nightly balance sessions need a sanctioned way to dispatch the canonical
  sweep, or the issue should instruct the filer to dispatch a fresh 100-seed main
  sweep ahead of assignment, since every stale-baseline night otherwise
  terminates without evaluating a single candidate.
