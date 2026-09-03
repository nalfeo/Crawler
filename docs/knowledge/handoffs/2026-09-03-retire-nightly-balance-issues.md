# Retire nightly balance improvement issues

## Date

2026-09-03

## Persona

DevOps Engineer

## Systems touched

ci-policy, release-baseline

## Apples

3🍎 estimated, 3🍎 actual (exact). The change removed two trigger paths, extracted
the shared recurring-issue helper, retired balance-only approval exceptions, and
added deterministic regression coverage.

## What changed

- Deleted the scheduled/manual `nightly-balance-issue.yml` workflow.
- Removed the post-publication balance issue step from `deploy.yml`. Release
  baseline generation, publication to the `baselines` branch, regression
  detection, and report-only issue paths remain unchanged.
- Deleted the balance issue prompt, entrypoint, and issue-specific baseline
  resolver. The active perf and velocity issue generators now import the same
  dedupe/intake behavior from the neutral `nightly-agent-issue` helper.
- Removed the obsolete `copilot/balance-telemetry*` branch-prefix fallback from
  human-approval reruns, merge-train admission, CI recovery, conflict
  coordination, and reviewer-request coverage. Label- and closing-issue-based
  human approval remains intact for all current workflows.
- Added a guard test that scans executable action/workflow/script sources and fails if
  the retired issue title is reintroduced. It also proves release baseline
  collection and publication remain wired.

## Intervention log

| Item                           | Record                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Why the loop existed           | A daily schedule and every successful release-baseline publication opened or refreshed a Copilot task asking for telemetry-backed balance improvements. The intent was to turn durable headless baseline data into measured tuning proposals.                                                   |
| Manual action required         | Each issue still needed an agent to investigate telemetry, dispatch canonical comparison sweeps, maintain an evidence ledger, close no-op outcomes, and obtain explicit owner approval before any gameplay PR could merge. The recurring issues accumulated because that work was not selected. |
| Permanent intervention         | Remove every automated creation trigger and the balance-only branch-name recovery rules while retaining baseline collection/viewing and unrelated perf, velocity, and regression issue generators.                                                                                              |
| Preventive guard               | `.github/scripts/nightly-agent-issue/retired-balance-issue.test.mjs` rejects any executable action, workflow, or script source containing the retired exact title.                                                                                                                              |
| Suggested effectiveness metric | For each scheduled issue generator, track `issues acted on within 30 days / issues created`; flag generators at 0% for 30 days or three consecutive untouched issues for maintainer review and retirement.                                                                                      |

## Validation

- Recurring-issue, approval, reviewer-request, deploy-workflow, CI recovery, and
  conflict-coordinator regression suites passed.
- `npm run verify:fast` passed.
- The executable automation scan contains no path capable of filing
  `balance: telemetry-driven nightly improvement sweep`.

## Notes

The historical handoffs that explain the former mechanism remain unchanged.
They are provenance, not executable automation.
