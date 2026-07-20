# Session Handoff: Post-Rollout CI Efficiency Measurement (Issue #1702)

## Date

2026-07-19

## Systems touched

ci-policy, tooling

## Persona(s) adopted

**DevOps Engineer / QA Engineer** — as specified in the issue. Investigation session
scoped to analysis tooling; no workflow modifications.

## Routing verdict

✅ Recommended (implementation session). Measurement tooling created and committed;
actual post-rollout analysis is timing-gated on dependency merges + 7 days.

## Apples

Estimated: 🍎 × 3
Actual: 🍎 × 3
Verdict: 🎯 Exact

## Critical timing finding

All dependency issues were opened TODAY (2026-07-19) and are all OPEN:

| Issue | Title                                               | Status        |
| ----- | --------------------------------------------------- | ------------- |
| #1688 | Add orthogonal PR change-impact classification      | OPEN (Wave 1) |
| #1689 | Cancel superseded CI and Security runs              | OPEN (Wave 1) |
| #1696 | Gate headless and coverage jobs by change impact    | OPEN (Wave 2) |
| #1697 | Path-gate Security checks and deduplicate npm audit | OPEN (Wave 2) |
| #1698 | Route visual validation by affected surface         | OPEN (Wave 2) |

**The rollout has not happened.** This issue (#1702) is Wave 4 and requires all five
dependencies to be merged PLUS seven representative post-rollout days. The actual
measurement window has not started.

## What was done

1. **Posted plan comment** on issue #1702 explaining the timing constraint, methodology,
   and what will be done in this session vs. what must wait.

2. **Created analysis script**: `scripts/agent/ci/measure-ci-efficiency.ts`
   - Queries GitHub Actions REST API for CI (workflow 288745068) and Security
     (workflow 291101062) workflow runs in a configurable time window
   - Classifies each run's change impact using the same path-pattern logic as
     `detect-art-only.sh` (art_only / docs_only / gameplay_safe / sprites_only / full / unknown)
   - Detects superseded runs via timestamp overlap analysis
   - Computes: total runner-minutes, avoidable%, superseded minutes, non-visual E2E,
     non-sim headless, non-coverage minutes
   - Reports per-PR median and p95 runner-minutes
   - Reports wall-clock latency (median and p95)
   - Documents API coverage limitations
   - Detects potential classifier-caused required-check gaps
   - Outputs a structured Markdown + JSON report ready for comparison to the baseline

3. **Baseline documented** in the script header and report template:
   - 18,630 measured CI/Security runner-minutes (72h ending 2026-07-19 19:12 UTC)
   - 99.54% classified
   - 53.9% conservatively avoidable
   - 3,808 superseded runner-minutes
   - 2,636 non-visual E2E minutes
   - 4,236 non-simulation headless minutes
   - 1,106 non-coverage coverage minutes

## How to run the post-rollout analysis

After all five dependencies merge and 7 representative days have elapsed:

```bash
# Install tsx if not already available
npm install -g tsx

# Run the analysis for the post-rollout window
GH_TOKEN=<your-pat-with-actions-read> npx tsx scripts/agent/ci/measure-ci-efficiency.ts \
  --start <merge-date>T00:00:00Z \
  --end <merge-date-plus-7d>T23:59:59Z \
  --owner nalfeo \
  --repo Crawler \
  --out docs/knowledge/metrics/ci-efficiency-post-rollout.json
```

The script outputs a Markdown report to stdout and optionally writes JSON to `--out`.
Re-dispatching this issue after the window opens is recommended.

## Classification methodology (post-rollout additions)

The new flags from #1688 (`visual_touched`, `sim_touched`, `coverage_touched`,
`sprite_pipeline_touched`, `dependencies_touched`) will need to be added to the
`classifyFiles()` function in the analysis script once #1688 merges. The current
implementation covers only the pre-#1688 flags. Update the script before running
the actual post-rollout analysis.

## API limitations (documented in script)

- GitHub `/actions/runs/{id}/timing` returns BILLABLE ms (rounded to 1 min); queue
  overhead is excluded. The script uses job `started_at`/`completed_at` instead
  for wall-clock accuracy.
- Superseded detection approximates from run timestamps; GitHub doesn't expose
  cancellation events directly.
- PR file listings capped at 3000 files by the GitHub API.
- Workflow runs older than 90 days may be unavailable.

## Acceptance criteria status

| Criterion                                  | Status                                    |
| ------------------------------------------ | ----------------------------------------- |
| ≥7 representative post-rollout days        | ⏳ Not started (rollout not yet deployed) |
| ≥95% classification rate                   | ⏳ Pending                                |
| Avoidable share < 15%                      | ⏳ Pending                                |
| Superseded waste −90%                      | ⏳ Pending                                |
| Median + p95 runner-minutes per PR head    | ⏳ Pending (tooling ready)                |
| Zero classifier-caused required-check gaps | ⏳ Pending                                |
| Wall-clock latency comparison              | ⏳ Pending (tooling ready)                |
| Follow-up issues for >5% waste sources     | ⏳ Pending                                |

## What's next

1. #1688, #1689 (Wave 1) — implement and merge the classifier + cancellation PRs
2. #1696, #1697, #1698 (Wave 2) — implement and merge the gating PRs
3. Wait 7 representative days
4. Re-dispatch issue #1702 to run `measure-ci-efficiency.ts` against the post-rollout window
5. If new flags from #1688 are available, update the `classifyFiles()` function in the script
6. File follow-up issues for any remaining >5% waste sources
