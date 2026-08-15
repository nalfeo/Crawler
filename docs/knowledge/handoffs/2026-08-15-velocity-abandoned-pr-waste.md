# Handoff: velocity bottleneck scan — abandoned-PR waste panel

## Date

2026-08-15

## Persona

Velocity Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎. Tooling-only (capped at 3🍎 per `AGENTS.md`), so no review
ledger is required at this tier.

## Summary

Ran the nightly velocity bottleneck loop for `nalfeo/Crawler#2973`. The top deterministic
bottleneck is **abandoned-PR churn** — roughly one in four closed PRs never merges — and
`npm run velocity:scan` could not see it at all, because it only samples `states: MERGED`.
Landed the smallest measurable fix: a closed-unmerged **waste panel** plus a threshold
finding in the scan, so the nightly loop reports the waste rate and its dominant lifecycle
class.

## Bottleneck evidence

### 1. Guard friction — already remediated, not the top bottleneck

Source: `docs/knowledge/metrics/guard-telemetry/*.json`, 134 non-quarantined sessions.

| Guard                 | Allow  | Deny |
| --------------------- | ------ | ---- |
| `pr-review-ledger`    | 210    | 8    |
| `pr-preflight`        | 235    | 7    |
| `authoring-main-sync` | 42,471 | 0    |

~15 denials over 134 sessions (≈0.11 denials/session). PR #2687 already added guard-specific
remediation hints for both denial sources. Not worth a second pass.

### 2. PR lifecycle waste — the top bottleneck

Source: GitHub API, the 100 most-recently-created **closed** PRs (2026-08-03 → 2026-08-15).

| Outcome                                          | Count   |
| ------------------------------------------------ | ------- |
| Merged                                           | 77      |
| Closed unmerged (`ci-lifecycle-abandoned`)       | 11      |
| Closed unmerged (`copilot-empty-draft-repaired`) | 10      |
| Closed unmerged (no lifecycle label)             | 2       |
| **Waste rate**                                   | **23%** |

The most recent 24h window is far worse: 17 abandoned vs 5 merged. Clusters are visible —
e.g. PRs #2924/#2927/#2930/#2933/#2935/#2937 are six consecutive `[WIP] Fix Floor 1 release
sweep loss …` sessions, all abandoned, and #2944/#2946/#2948/#2953/#2954/#2955/#2956 are
empty Copilot drafts.

Each abandoned PR costs a full agent session plus CI minutes and ships nothing, yet it
contributes **zero** to every metric the scan reported: stage timings, lead time by size,
and the slowest-PR list are all computed from merged PRs only, and the open-PR aging panel
drops a PR the moment it closes. The largest observable waste stream in the repo was
structurally invisible to the nightly loop.

## Fix

`scripts/agent/velocity/bottleneck-scan.ts`:

- `fetchClosedPrs(root, limit)` — a deliberately light `states: [MERGED, CLOSED]` GraphQL
  query (no commits/reviews, so no node-ceiling risk), cursor-paged and de-duplicated like
  the existing fetchers.
- `computeAbandonedWaste(prs)` — pure function returning `closedPrs`, `merged`,
  `abandoned`, `wasteRate`, a lifecycle-`labelBreakdown` (with an explicit
  `(no lifecycle label)` bucket so unlabeled abandonment cannot hide), and the 5 most
  recently abandoned PRs.
- `deriveFindings` — raises a finding at `wasteRate >= WASTE_RATE_ALERT` (0.15) once the
  sample reaches `WASTE_MIN_SAMPLE` (20) closed PRs, naming the dominant class. Both
  thresholds are exported constants, so they are inspectable and testable.
- Renderer — new `─── Abandoned PR waste ───` section with a `⚠ WASTE ALARM` marker.
- `abandonedWaste` is `null` when the caller supplies no closed-PR data, matching the
  established `openPrAging` convention (a supplied-but-empty window stays a real panel).

`docs/agent-os/policies/velocity-lab-policy.md` §10 updated: the scan now also mines
closed-unmerged history.

## Measurable before/after

Observed by running the real CLI end-to-end against a fixture `gh` that mirrors the
measured 2026-08-15 distribution (77 merged / 11 / 10 / 2):

| Metric                                  | Before       | After                                     |
| --------------------------------------- | ------------ | ----------------------------------------- |
| Closed-unmerged PRs sampled by the scan | 0            | 100                                       |
| Waste rate reported                     | not measured | `23 of 100 closed PRs never merged (23%)` |
| Dominant waste class named              | no           | `ci-lifecycle-abandoned` (11 of 23)       |
| Unlabeled abandonment visible           | no           | `2  (no lifecycle label)`                 |
| Tests over the waste path               | 0            | 10                                        |

Rendered finding (new):

```
23 of 100 closed PRs (23%) never merged — that work consumed agent sessions and CI
minutes and shipped nothing, and it is invisible in merged-PR lead time. Dominant
class: "ci-lifecycle-abandoned" (11 of 23). Fix the automation that produces this
class before optimizing any stage timing.
```

Per §10 of the velocity lab policy this is observational, not causal: it is a metric that
makes the next fix measurable, not a claim that the fix itself has landed.

## Verification

- `npx vitest run tests/unit/velocity/` → 179 tests, 8 files, all passing ✅
- End-to-end CLI run against a fixture `gh` on `PATH` → new panel + finding render as
  shown above ✅
- `npx tsc --noEmit --project tsconfig.json` → 0 errors ✅
- `npx eslint scripts/agent/velocity/bottleneck-scan.ts tests/unit/velocity/bottleneck-scan.test.ts` → 0 errors ✅
- `npx prettier --write` on both files ✅

## Refs

Refs nalfeo/Crawler#2973

## Recommended next steps

1. Re-run `npm run velocity:scan -- --limit 100` on a runner with `gh` auth to capture a
   live baseline waste rate, and record it as the before-number for any disposition fix.
2. Attack the dominant class next: the `[WIP] Fix Floor 1 release sweep loss …` cluster
   suggests `ci-recovery` re-files a fresh PR per failing commit instead of reusing an open
   recovery PR. Dedup there should move the waste rate directly, and it is now measurable.
3. Empty Copilot drafts (`copilot-empty-draft-repaired`) are the second class; PR #2950
   already stopped auto-closing brand-new empty PRs as duplicates, so re-measure that
   sub-rate on a post-2026-08-15 cohort before adding more automation.
