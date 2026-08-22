# Session Handoff: Floor 2 regression automation moved into the release workflow

## Date

2026-08-22

## Persona

DevOps Engineer

## Systems touched

ci-policy, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact) — tooling/automation only, ceremony-capped at 3🍎.

## What Was Done

Issue #3293: the Floor 2 / floor1→2 chain win-rate ask that PR #3241 added as a
clause inside the **nightly balance issue** was moved to the **release workflow**,
so it behaves like the existing Floor 1 "must be 100%" check.

- `scripts/agent/perf/baseline-regression-check.ts` gained `evaluateLegWinRateFloor()`:
  an **absolute** 90% win-rate floor on the report-only release legs, evaluated
  against the current baseline alone (no previous baseline, no trend delta —
  exactly like the Floor 1 100% invariant). Monitored leg ids are derived from
  `RELEASE_SWEEP_LEGS` (the non-blocking legs) rather than a second hardcoded
  list. `main()` writes a second result JSON and a second `legWinRateFloorBreach`
  output when `LEG_WIN_RATE_FLOOR_RESULT` is set.
- `deploy.yml` gained one conditional filing step reusing the existing
  `baseline-regression-issue.mjs` filer (same labels + Copilot issue intake).
- `baseline-regression-issue.mjs`'s marker path now converges deterministically
  on the lowest-numbered open match and closes the rest as superseded.
- The nightly clause (`buildWinRateInvestigationClause`) and its constants were
  deleted; its investigative guidance is preserved verbatim in the new issue body.

Observed against real published data, not a fixture: fetched the `baselines`
branch and ran the CLI over the actual latest release baseline
(`8b2fc48`, legs `floor2` 54/150, `floor1-chain` 84/150). Before: no
report-only verdict existed at all. After: `legWinRateFloorBreach=true` with
`floor2 36.00%, floor1-chain 56.00% below the 90% target`, and the aggregate
Floor-1 decision was byte-for-byte unchanged (`regression=false`).

## Key Decisions Made

- **Two independent decisions, not one.** The aggregate decision carries exactly
  one issue and returns early on a Floor 1 loss, so folding the leg floor into it
  would let a Floor 1 loss mask a Floor 2 breach in the same release.
- **Absolute floor, not a trend delta.** A trend-only rule lets a chronically low
  leg quietly become the new normal. This is the same reasoning that already
  makes Floor 1's 100% requirement independent of any comparison baseline.
- **Stable marker, not a per-commit marker.** The release workflow runs on every
  main deploy; a per-commit marker would open a fresh issue every release while a
  leg sits under target. The stable marker + duplicate-collapse means one
  long-lived investigation issue refreshed with the newest numbers.
- **Report-only legs stay report-only.** This files an issue; it does not fail the
  deploy. Making Floor 2 blocking at today's ~36% would red-wall every release —
  that is a maintainer gameplay decision, not automation plumbing.
- **Fail closed on a missing monitored leg** when the baseline was captured under
  the current `RELEASE_SWEEP_REVISION` (a truncated publisher or a silent rename
  would otherwise retire the check); older revisions are skipped as history.

## What's Next / Blockers

- The check will fire on the next release (both legs are far under target). The
  resulting issue is the Floor-2 win-rate work itself — that gameplay fix is
  deliberately **not** in this PR.
- If Floor 2 is ever intended to become a **blocking** release leg, that is a
  separate, explicit maintainer decision: flip `blocking` in `sweep-legs.ts` and
  decide what "fail the release" should mean for a report-only-derived target.

## Retrospective

### Lessons Learned

- The `baselines` branch makes automation changes genuinely observable: a
  `git fetch origin baselines` plus one CLI run validated the new check against
  real 600-run release data instead of a hand-made fixture. Do this for any
  baseline-consuming change — it caught nothing here only because the unit tests
  already covered the shape, but it is far stronger evidence.
- Prettier realigns an **entire** markdown table to its widest cell. Adding a
  long file path to `ci-config-knobs.md` turned a one-line edit into a 122-line
  diff; shortening the cell to a bare filename (matching neighbouring rows) got
  it back to a single changed line.
- `npm run review:grade record` binds the grade to a **clean tree**, so commit the
  ledger's earlier stages before generating the grading packet — otherwise the
  packet head SHA moves out from under the recorded grade and you re-grade.

### Mistakes Made

- Generated the grading packet before committing the ledger scaffold, so the
  graded tree SHA was stale by one commit and the grade had to be re-run. Early
  signal: `record: working tree is dirty` — that message means "commit first",
  not "force it".
- First draft of the new unit tests reused a helper that only populated one
  monitored leg, which tripped the new fail-closed branch. That was the guard
  working as designed; the fix was in the test fixture, not the check.

### Opportunities for Future Improvement

- The release job is only serialized **per head SHA**, which is why the stable
  marker needed duplicate-collapse at all. A global `baseline-issue-filing`
  concurrency group would remove the race at the source rather than healing it
  after the fact.
- `evaluateBaselineRegression` and `evaluateLegWinRateFloor` now both format leg
  tables; a shared `formatLegTable()` would remove that duplication if a third
  consumer appears.
