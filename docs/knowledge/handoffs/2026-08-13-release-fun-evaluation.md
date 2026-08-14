# Score fun evaluation on the post-release baseline sweep

## Date

2026-08-13

## Persona

DevOps Engineer

## Systems touched

ci-policy, ai-combat-balance

## Apples

This release-sweep expansion is part of the session's 5-apple runtime telemetry
change. It wires the evaluator into an existing CI stage with a new persistence
contract and adds graceful-degradation viewer support for a third artifact
shape.

## What changed

- The canonical "post-release sweep" is `deploy.yml`'s `baseline-sweep` job —
  the same job the `2026-08-13-persist-release-telemetry` handoff made
  persist a complete 600-run `RunStats[]` cohort. `ai-sweep.yml` remains the
  separate balance-search pipeline; it is not touched by this change.
- `scripts/agent/perf/release-fun-report.ts` (new) scores that cohort with the
  existing, unmodified evaluator (`scoreFunSessions`/`normalizeFunSessions` in
  `scripts/agent/health/fun-score-lib.ts` — the same code the `fun-score` CLI
  and `playtest-fun-rater` skill use) and writes
  `{ meta: ReleaseBaselineMeta, report: FunScoreReport }` to
  `.cache/baseline/fun-report.json`.
- `deploy.yml`'s `baseline-sweep` job runs this immediately after "Enrich
  baseline with commit metadata" (once `runs` + `meta` both exist on
  `baseline.json`) and before "Publish to baselines branch". A scoring
  failure is downgraded to a `::warning::` — fun evaluation is diagnostic and
  trendable, never a release gate, so it must never fail an already-shipped
  deploy.
- The `baselines` branch publish step now also writes
  `by-sha/<sha>.fun-report.json` when present, and `index.json` entries carry
  an optional `fun: { overallFunScore, gatePass, path }` field folded in from
  that sibling file. Both the publish step and the index builder tolerate a
  missing fun-report file (legacy releases predating this change, or a
  scoring failure), leaving `fun: null` rather than failing.
- The "Upload baseline as artifact" step now uploads `fun-report.json`
  alongside `baseline.json` in the same `baseline-<short-sha>` artifact
  (`if-no-files-found: warn` already tolerated a missing file).
- `.github/extensions/sweep-results-viewer` gained a third, deliberately
  minimal `workflowType: 'baseline-sweep'` path:
  - `deploy.yml` runs continuously (every push to main) and is **not**
    enumerated in the default weapon-sweep/AI-Sweep-Eval browse catalog
    (`listAllSweepRuns`) — that would make an automatic, mostly-non-sweep
    workflow dominate the manually-dispatched sweep picker.
  - A specific run id (e.g. `meta.runId`/`meta.runUrl` from a published
    baseline, or the release-baseline PR comment's sweep-run link) is still
    directly selectable: `getBaselineSweepRun` validates the run's workflow
    `path` and `select_cloud_run`/the `runId` canvas input transparently fall
    back to it when the id isn't a weapon-sweep/AI-Sweep-Eval run.
  - The renderer shows commit, win rate, per-weapon breakdown, and the fun
    report (overall score, gate pass/fail, dimensions, hotspots) when
    present, or an explicit "Fun evaluation report is not available for this
    run" message when the sibling file is absent — never an error.

## Storage contract

`.cache/baseline/fun-report.json` (and its published `by-sha/<sha>.fun-report.json`
sibling) is:

```text
{
  meta: ReleaseBaselineMeta,   // identical to baseline.json's meta
  report: FunScoreReport,      // scripts/agent/health/fun-score-lib.ts
}
```

`index.json` entries gain an optional field, `null` for any commit without a
fun-report file:

```text
fun: { overallFunScore: number, gatePass: boolean, path: string } | null
```

## Verification

- Focused wiring/scoring/serialization tests:
  `tests/unit/release-fun-report.test.ts` (4 tests) plus updated assertions in
  `tests/unit/release-baseline.test.ts`.
- `npm run test:sweep-viewer`: 70 tests passed (15 new: artifact-name
  matching, warning states including the graceful missing-report path,
  `getBaselineSweepRun` workflow-path/error validation, explicit-run selector
  state, and renderer markers).
- Focused deploy-workflow validation:
  `tests/unit/deploy-workflow-gating.test.ts` verifies same-SHA stale-report
  cleanup and malformed historical-report handling.
- `npm run typecheck`: passed.
- `npm run verify:fast`: passed.
- `npm run check:extensions`: passed (113 files, no bare-import violations).

## Review

The final expanded diff completed the 5-apple review harness. Reviewers found
and the implementation fixed explicit-run selector mismatch, stale same-SHA
report retention, operational-error masking, and malformed historical report
handling. Final single-model and multi-model rounds were clean.

## Follow-up

- No trend comparison (`--baseline`) is wired for the release fun-eval report
  yet — each release is scored independently. If release-over-release fun
  drift needs its own regression detector (mirroring
  `baseline-regression-check.ts`), that is a separate, deliberately deferred
  piece of scope.
