# Session Handoff: Nightly balance sweep — no eligible baseline, terminal no-PR outcome

## Date

2026-08-20

## Persona

Playtester → DevOps Engineer

## Systems touched

ci-policy, ai-combat-balance

## Apples

2🍎 exact

## What Was Done

Executed issue #3185 (`balance: telemetry-driven nightly improvement sweep`) end to
end against its hard evidence gates. **Zero candidates were proposed and no gameplay
change was made**: the baseline eligibility gate fails, so nothing could be measured,
attributed, or evaluated. The session then fixed the systemic reason the gate keeps
failing.

### Baseline audit (facts, from the GitHub Actions API)

| Field                                                                                                             | Value                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest successful `weapon-sweep.yml` run on `main`                                                                | [`31744723997`](https://github.com/nalfeo/Crawler/actions/runs/31744723997)                                                                                                         |
| Dispatched (UTC)                                                                                                  | 2026-08-13T21:14:21Z (aggregates written 21:18–21:19Z)                                                                                                                              |
| Head SHA                                                                                                          | `5ea6cb36f0253d362abc7ba47a5ea6d0a1594d4a`                                                                                                                                          |
| FINAL aggregate artifacts                                                                                         | all six present, unexpired (expire 2026-09-12)                                                                                                                                      |
| Seeds recorded in `weapon-sweep-sword.json`                                                                       | 1–30 (`runs: 30`) — **not 100/weapon**                                                                                                                                              |
| `maxFrames` / `budgetSec` / `weaponPersonas` / `floors`                                                           | 23760 / 396 / `true` / `[1]`                                                                                                                                                        |
| Second-newest `main` run [`31730947008`](https://github.com/nalfeo/Crawler/actions/runs/31730947008) (`30cb03d2`) | only 3 FINAL aggregates (sword, bow, baseball-bat)                                                                                                                                  |
| Older `main` runs                                                                                                 | all from 2026-07-16 or earlier — artifacts past the 30-day retention                                                                                                                |
| Current `main` at analysis time                                                                                   | `578ffc9d5f0fac64b986cac8fa7bef8a6ec8274e`                                                                                                                                          |
| Commits on `main` after the baseline SHA                                                                          | 117, including gameplay changes #3015 (item prices), #3021 (Floor-1 boss chest drops), #3035 (sealed-arena engagement), #3104/#3141 (gear unlock gating), #3133 (baby-slime spawns) |

Honesty statement required by the issue: this is **headless simulation telemetry
only**. No release/tag data and no real-player telemetry were consulted or implied,
and no lookback window was invented.

### Durable ledger (max 9 rows)

| #   | Name           | Measured symptom                                                                                             | Causal evidence                                                                                                                             | Production path | Enabling config/flag | Hypothesis | Exact change | Baseline metrics | Post metrics | Run/artifact URLs                                                             | Verdict                                                                                                      |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------- | ---------- | ------------ | ---------------- | ------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| —   | (no candidate) | Baseline gate failed before any candidate could be measured: newest `main` sweep is 30 seeds/weapon, not 100 | `weapon-sweep-sword` aggregate of run 31744723997 records `seeds: [1..30]`, `runs: 30`                                                      | n/a             | n/a                  | n/a        | none         | n/a              | n/a          | [run 31744723997](https://github.com/nalfeo/Crawler/actions/runs/31744723997) | **Blocked** — ineligible sample size                                                                         |
| —   | (no candidate) | Six-artifact gate failed on the only other unexpired `main` run                                              | Run 31730947008 published FINAL aggregates for sword, bow, baseball-bat only                                                                | n/a             | n/a                  | n/a        | none         | n/a              | n/a          | [run 31730947008](https://github.com/nalfeo/Crawler/actions/runs/31730947008) | **Blocked** — partial weapon list                                                                            |
| —   | (no candidate) | Even if sample size matched, the baseline SHA no longer represents `main`                                    | 117 commits landed after `5ea6cb36`, several gameplay-affecting (#3015, #3021, #3035, #3104, #3141)                                         | n/a             | n/a                  | n/a        | none         | n/a              | n/a          | `git log 5ea6cb36..578ffc9d`                                                  | **Blocked** — stale baseline                                                                                 |
| —   | (no candidate) | A fresh canonical sweep could not be dispatched from this session                                            | `POST /repos/nalfeo/Crawler/actions/workflows/weapon-sweep.yml/dispatches` → HTTP 403 `Blocked by DNS monitoring proxy` (GET calls succeed) | n/a             | n/a                  | n/a        | none         | n/a              | n/a          | n/a                                                                           | **Blocked** — evaluation contract's "inability to run an independent canonical sweep ⇒ no implementation/PR" |

Verdict: **0 eligible candidates, 0 evaluation attempts, no gameplay PR.** Nothing was
tuned, and no seed-level or shard-level data was used to manufacture a candidate.

### Systemic fix landed instead (automation only, no gameplay change)

The nightly issue is filed daily, but its baseline gate pointed at ad-hoc
`weapon-sweep.yml` dispatches: the sweeps on `main` were human-run (30 seeds, or a
3-weapon subset), Actions artifacts expire after 30 days, and Copilot sessions cannot
dispatch workflows. Every nightly therefore terminated on the same gate.

The repository already publishes a durable release sweep: after every successful main
deploy, `deploy.yml` commits the full baseline to the `baselines` branch
(`by-sha/<commit>.json` plus a newest-first `index.json`). That data is always in git,
never expires, and its shape follows whatever the release sweep currently measures —
including the floor-2 and chained legs added when the 600-run Floor-1 sweep was
rebalanced. Changes:

- `.github/scripts/nightly-balance-issue/release-baseline.mjs` (new) resolves the
  newest entry of `baselines/index.json` (sorting defensively by commit date rather
  than trusting index order) and returns it with blob links to the payload and fun
  report. It validates only `commit` and `path`; the sweep formulation — weapons, seed
  range, floor legs, budgets — is deliberately never asserted.
- The issue body's baseline gate now names that release baseline, stamps the resolved
  commit/date/run counts/legs into the issue at filing time, and instructs the session
  to read the sweep's shape from `meta.sweep`/`legs`/`perWeapon`/`runs` instead of
  assuming a fixed formulation. It no longer requires six FINAL weapon aggregates at
  100 seeds/weapon, and no longer asks the session to dispatch a baseline sweep it
  cannot dispatch: the next release publishes the next baseline.
- `.github/scripts/nightly-balance-issue/run.mjs` resolves the baseline (a read-only
  lookup) and binds it into the body builder; a lookup failure is reported and never
  blocks issue filing.
- `package.json` `test:guards` now includes
  `.github/scripts/nightly-balance-issue/*.test.mjs`, which was missing (its sibling
  velocity/perf filers were already registered), so these tests actually run in CI.

An earlier revision of this session instead dispatched a canonical 100-seed six-weapon
`weapon-sweep.yml` run from the filer. The repository owner rejected that design: it
pinned one sweep formulation that has since been rebalanced, and it ignored the
release sweep data that is already durably in git. That approach and its
`weapon-sweep.yml` run-name stamping were reverted.

## Key Decisions Made

- **Refused to manufacture candidates.** Sub-sample (30-seed), partial-weapon, and
  stale-SHA data are all explicitly ineligible; proposing tuning from them would have
  violated the issue's hard gates and rule #11/#12.
- **Fixed the cause, not the symptom.** The recurring terminal outcome is an
  unreachable baseline definition, not a shortage of ideas; pointing the gate at the
  git-persisted release baseline is the smallest change that unblocks every future
  nightly run.
- **The gate must not pin a sweep formulation.** Weapon list, seed count, floor legs,
  and frame budgets all change as the release sweep is rebalanced, so the contract
  names the newest published baseline and requires the session to record whatever that
  payload actually contains.

## What's Next / Blockers

- **Issue #3185 must be closed with the no-PR rationale.** This session cannot post
  issue comments or close issues (all GitHub write endpoints are blocked at the agent
  sandbox proxy), so the accompanying PR carries `Closes nalfeo/Crawler#3185` and this
  ledger; merging it closes the issue and unblocks future nightly filings.
- The next nightly run resolves the newest `baselines/index.json` entry (at the time of
  writing, release baseline `578ffc9d` captured 2026-08-20T08:45Z, 300 floor-1 runs
  plus floor-2 and floor-1-chain legs) and starts from a named, unexpired baseline
  instead of hunting for an eligible Actions run.

## Retrospective

### Lessons Learned

- The Copilot agent sandbox permits GitHub **GET** traffic but blocks every write
  (`HTTP 403 Blocked by DNS monitoring proxy`), including `workflow_dispatch`. Any
  contract that asks a session to "run a canonical sweep itself" is unsatisfiable —
  the dispatch has to come from a workflow.
- Durable evidence already existed on the `baselines` branch; the gate was reaching for
  ephemeral Actions artifacts instead. Prefer git-persisted telemetry over artifacts
  whenever a contract has to hold for longer than the 30-day retention window.
- Artifact **names** are not evidence of sample size. `weapon-sweep-sword` looked like
  a valid FINAL aggregate; only opening the JSON revealed `runs: 30`. Always read
  `seeds`/`runs`/`maxFrames` out of the aggregate before calling a baseline canonical.
- Actions artifacts expire after 30 days, so "latest successful `main` sweep" can be
  simultaneously the newest and completely unusable.

### Mistakes Made

- Started by trusting the newest `main` sweep run as the baseline because it had all
  six FINAL aggregate artifacts, and only checked the seed count after downloading the
  sword aggregate. Early signal: the artifacts were ~2.5 KB each — far too small for
  100 per-seed records.
- Attempted `gh workflow run` before confirming the sandbox blocks write API calls;
  the failure mode (`invalid character 'B' looking for beginning of value`) is the
  proxy's plaintext "Blocked by DNS monitoring proxy" body being parsed as JSON.

### Opportunities for Future Improvement

- The filer could also stamp the delta between the baseline commit and current main
  (gameplay-affecting commit count), so the session does not recompute it.
- Candidate evaluation still relies on dispatched `weapon-sweep.yml` runs, which a
  Copilot session cannot start; a comparable evaluation path built on release
  baselines, or a dispatch trampoline workflow, would close the remaining gap.
- The velocity/perf nightly filers have the same "no fresh evidence" exposure and may
  deserve the same pre-flight evidence guarantee.
