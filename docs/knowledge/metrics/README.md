# Metrics

Machine-written, machine-read JSON trend files maintained by the looping
automation workflows (`.github/workflows/test-health.yml`).

| File                    | Owner                                            |
| ----------------------- | ------------------------------------------------ |
| `coverage-trend.json`   | `scripts/agent/health/coverage-trend.ts`         |
| `balance-baseline.json` | `scripts/agent/health/balance-regression.ts`     |

Edit by hand only when you intentionally need to reset a baseline (e.g. after a
deliberate balance pass). Record the rationale in a handoff.
