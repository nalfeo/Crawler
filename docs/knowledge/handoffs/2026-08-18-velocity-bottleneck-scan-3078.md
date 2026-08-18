# Session Handoff: nightly velocity bottleneck scan (#3078) — no new actionable bottleneck

## Date

2026-08-18

## Persona

Velocity Engineer

## Systems touched

ci-policy

## Apples

1🍎 (investigation/documentation only, no code change; no review ledger required at this tier).

## What Was Done

Ran the nightly velocity-engineer bottleneck-scan loop for `nalfeo/Crawler#3078`. `gh` is
not authenticated in this sandbox (`gh auth status` → not logged in, so
`npm run velocity:scan` fails immediately on `gh repo view`), so evidence was gathered
manually via the GitHub MCP tools instead of the committed `bottleneck-scan.ts` script.
Conclusion: **no new actionable bottleneck** — the last identified top bottleneck (empty-draft
and abandoned-PR waste, fixed in `Refs nalfeo/Crawler#3024` / 2026-08-17) has already dropped
to zero recurrences, and no other signal crosses an alert threshold this cycle.

## Bottleneck evidence

### 1. PR lifecycle waste — previously the top bottleneck, now resolved

Source: GitHub API, 100 most-recently-updated **closed** PRs (`#2823`–`#3070`, spanning
2026-08-13 → 2026-08-18).

| Outcome                                          | Count |
| ------------------------------------------------ | ----- |
| Merged                                           | 72    |
| Closed unmerged (`copilot-empty-draft-repaired`) | 15    |
| Closed unmerged (`ci-lifecycle-abandoned`)       | 10    |
| Closed unmerged (other/no label)                 | 3     |
| **Waste rate**                                   | 28%   |

That 28% looks alarming in isolation (above the `WASTE_RATE_ALERT` 0.15 threshold), but every
single one of the 28 closed-unmerged PRs was **created on 2026-08-14 or 2026-08-15** — a burst
that predates the empty-draft repeat-budget fix (`docs/knowledge/handoffs/2026-08-17-velocity-empty-draft-repeat-budget.md`,
merged 2026-08-17). **Zero** closed-unmerged PRs have been created since 2026-08-15T21:12Z.
In the ~35h since that fix landed, 72 PRs merged cleanly and **none** were closed unmerged —
a full drop from "dominant waste class" to zero, which is exactly the "after" field
verification that handoff called for.

### 2. Merged-PR lead time — healthy, not degrading

Same 72-PR merged sample: median lead time (create → merge) **~2.26h**, p90 **~6.58h**, max
**~36.3h**. Comparable to the 2026-08-17 consult baseline (median ~1.98h, p90 ~7.63h) — no
regression, and no size bucket stands out (the MCP `list_pull_requests` tool does not expose
per-PR `additions`/`deletions` in bulk, only on single-PR `get`, so a full size-bucketed
breakdown wasn't reproducible outside the authenticated `bottleneck-scan.ts` run).

### 3. Open-PR aging — normal contention, already covered by existing tooling

11 open PRs at scan time; 7 older than 4h, oldest ~24h (`#3027`). Two of the open PRs
(`#3027` and `#3057`) turned out to be **independently-produced fixes for the same
optimization** (both trim `collisionSystem` size lookups — `#3057`'s body explicitly says it
recovers an abandoned branch doing the same thing). This looked like a possible new
duplicate-work bottleneck, but the repo already has automated **duplicate-PR** and
**already-landed (content-identical)** detection in `.github/workflows/ci-pr-disposition.yml`:
once either PR merges, the other's changed files will match `main`'s blob SHAs and it will be
auto-closed as `ALL_LANDED` on the next disposition run. No code gap here — the existing
guard is designed for exactly this case and just hasn't run since the collision happened.

### 4. Guard friction

Not re-aggregated this session (would require `docs/knowledge/metrics/guard-telemetry/*.json`
across many sessions); the 2026-08-17 consult's numbers (`pr-preflight` ~4.1% deny,
`pr-review-ledger` ~3.7% deny) are the most recent baseline and were not flagged as the top
bottleneck then either.

## Key Decisions Made

- Did not invent a fix to force a "landed" outcome. The issue's own required approach
  explicitly allows "if no actionable bottleneck is found, document that outcome and close
  the issue" — that is the honest read of this cycle's evidence.
- Did not build new duplicate-work detection for the `#3027`/`#3057` collision-perf overlap:
  the existing already-landed/duplicate-detection workflow already self-heals this class of
  waste once one PR merges, so adding code there would be solving an already-solved problem
  and risks false-positive closes on legitimately different content.
- Used manual GitHub API queries (`github-mcp-server` `list_pull_requests` /
  `pull_request_read`) in place of `npm run velocity:scan`, because `gh` has no auth token in
  this sandbox. This is a repeat of the same environment gap noted in
  `docs/knowledge/handoffs/2026-08-01-nightly-velocity-qualified-close.md`.

## What's Next / Blockers

- Re-run `npm run velocity:scan -- --limit 100` on an authenticated GitHub Actions runner (or
  a session with `gh` auth) in the next 24-48h to confirm the empty-draft/abandoned waste rate
  holds near zero under the committed tool's full stage-timing model, and to get a size-bucketed
  lead-time breakdown this session's tooling couldn't produce.
- If `#3027` and `#3057` are still both open after one of them merges, verify the
  already-landed detector actually closes the loser — that would confirm decision #2 above
  rather than leaving it as an assumption.

## Retrospective

- **What went well:** The manual GitHub-API evidence-gathering path was enough to reconstruct
  waste-rate and lead-time signals without `gh` auth, so the loop didn't stall on the
  environment gap the way the 2026-08-01 session did.
- **What was risky/uncertain:** Whether "no actionable bottleneck" is a satisfying answer for
  an issue that explicitly asked for a scan — mitigated by citing concrete before/after
  numbers showing the _previous_ fix already worked, rather than just saying "nothing found."
- **What to do differently:** Get `gh` authentication (or an equivalent MCP-backed
  `bottleneck-scan.ts` data source) working in this sandbox so future velocity sessions don't
  have to hand-roll GraphQL-equivalent queries via MCP tools.

## Refs

Refs nalfeo/Crawler#3078
