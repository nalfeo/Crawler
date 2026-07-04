# Metrics

Machine-written, machine-read JSON trend files maintained by the looping
automation workflows (primarily `.github/workflows/test-health.yml`) and by
in-session scripts under `scripts/agent/`.

| File / directory         | Owner                                                                             | Purpose                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `coverage-trend.json`    | `scripts/agent/health/coverage-trend.ts`                                          | Line/branch coverage trend across recent runs.                                              |
| `balance-baseline.json`  | `scripts/agent/health/balance-regression.ts`                                      | Baseline balance metrics; regressions trip the balance gate.                                |
| `bench-baseline.json`    | Bench / perf workflows                                                            | Baseline for perf benchmarks (bench comparison job).                                        |
| `mutation-baseline.json` | Stryker mutation-testing workflow                                                 | Baseline mutation score / surviving mutants.                                                |
| `apple-log.json`         | Apple-complexity policy (`docs/agent-os/policies/complexity-policy.md`)           | Aggregated per-session apple estimate-vs-actual verdicts (calibration).                     |
| `apples/`                | Same policy, per-session artifacts                                                | One `YYYY-MM-DD-<slug>.json` per session with declared estimate + scored actuals + verdict. |
| `guard-telemetry/`       | Deterministic guard scripts (docs/lint/wiring/etc. under `scripts/agent/guards/`) | Per-run telemetry summaries so guard drift is visible over time.                            |

Edit these by hand only when you intentionally need to reset a baseline (e.g.
after a deliberate balance pass or an approved mutation-score drop). Record the
rationale in a handoff.
