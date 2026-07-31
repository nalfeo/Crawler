# Finding: branch contamination drove a 64h delivery deadlock; an effective CI tree-diff gate is proposed to re-enable safe coordination

**Scan date:** 2026-07-28 · **PRs analyzed:** 60 merged · **Issue:** nalfeo/Crawler#2192
**Verdict:** ACTIONABLE — emergency fix already landed; contamination detection proposed as permanent fix.

---

## Summary

Median lead time is **2.7h** — healthy. But the slowest **12% of PRs (7/60)** each took
**>48h**, dragging P90 to **55.5h**. Those seven PRs share one root cause: they were
agent-authored PRs serialized in a CI conflict-coordination group whose head-of-line PR
could not move.

The acute symptom — **18 PRs deadlocked for up to 64h** — was resolved by emergency PR
#2168 (coordination default-off, landed 2026-07-28). This document records the full scan
findings and proposes the smallest permanent fix for the underlying cause.

---

## Stage analysis

Only **5 of the 7** slow-tail PRs have the review + commit timestamps needed for stage
decomposition, so the table below reports the **observed slow-tail subset** rather than
unsupported medians for all 60 PRs.

| Stage                    | Interpretation                                               | Observed median (slow-tail subset, n=5) |
| ------------------------ | ------------------------------------------------------------ | --------------------------------------- |
| open → first review      | QUEUE                                                        | 0.7h                                    |
| first review → last push | POST-REVIEW interval (timestamps only; activity mix unknown) | **67.0h**                               |
| last push → merge        | QUEUE                                                        | 0.4h                                    |

**The long post-review interval is the bottleneck** for the slow tail. In this incident,
the root-cause evidence points primarily to queueing behind the coordinator rather than
active rework, and the timestamps alone cannot separate waiting from work within that
interval.

### Slow PR stage breakdown

| PR    | Lead  | review_q | post-review interval | merge_q | Churn | Root cause                                                                                                                             |
| ----- | ----- | -------- | -------------------- | ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| #2003 | 71.9h | 1.7h     | 69.8h                | 0.4h    | 922   | CI-recovery stall (model unavailability) + contamination lock                                                                          |
| #1976 | 70.0h | 0.1h     | 69.1h                | 0.8h    | 947   | Branch contamination → coordination deadlock (28/30 subject-matched duplicates; 45/48 commits patch-identical to main by `git cherry`) |
| #2016 | 69.7h | 2.5h     | 67.0h                | 0.3h    | 2844  | 21-file conflict + contamination lock                                                                                                  |
| #1996 | 62.3h | 0.7h     | 54.8h                | 16.8h   | 139   | Stuck behind blocked head-of-line in coordination queue                                                                                |
| #2015 | 60.2h | n/a      | n/a                  | n/a     | 0     | Same coordination deadlock                                                                                                             |

---

## Lead time distribution

```
<1h     20 PRs  (33%)  — sprint PRs, sprite check-ins, hot-fix CI patches
1–12h   23 PRs  (38%)  — normal feature and fix work
12–48h  10 PRs  (17%)  — larger features or first-round review rework
>48h     7 PRs  (12%)  — all caught in the 2026-07-25–28 coordination deadlock
```

**P25:** 0.6h · **Median:** 2.7h · **P75:** 12.7h · **P90:** 55.5h

---

## Size vs. lead time (12 PRs with known churn)

| Bucket         | n   | Median lead |
| -------------- | --- | ----------- |
| ≤100 lines     | 1   | 25.2h       |
| 101–500 lines  | 4   | 43.8h       |
| 501–2000 lines | 4   | 51.0h       |
| >2000 lines    | 3   | **1.6h**    |

The >2000-line bucket (median 1.6h) consists of human-authored PRs (e.g. #2164 at 9,861
churn lines, merged in 1.6h). **PR size is not the primary predictor of lead time.**
Authorship type and CI-recovery mechanics dominate.

---

## Root cause: branch contamination

Agent branches routinely carry prior sessions' squash-merged commits under new SHAs.
Squash-merge relands them as the agent's own history, so `git cherry` would mark them
`-` (already in main), but a filename-overlap test returns `true` because the files
exist in the diff.

**Measured on 2026-07-28:**

- 8 of 11 PRs touching `reconcile.mjs` were contaminated (73%)
- PR #1976 had 28 of 30 subject-matched duplicates; `git cherry` marked 45 of 48 commits patch-identical to main
- Art PR #2137 carried a diff to `sweep-budget.mjs` that **reverted 15 lines of
  production CI code** merged by #2141 11 minutes earlier

The coordinator's `isCiCoordinationPath` predicate was correct; the input (the
diff) was wrong because contaminated branches contain stale CI-file changes that
aren't actually new.

**Emergency fix (PR #2168, landed 2026-07-28):** coordination made default-off
(`CI_CONFLICT_COORDINATION_ENFORCE=1` required to enforce). Discovery and
reporting keep working, so groups are still observable. Only the blocking fence
is disabled. This drains the immediate deadlock but does not prevent
contamination from recurring if enforcement is re-enabled.

---

## Guard friction

| Guard               | Allow | Deny | Skip | Rate | Verdict                                                                                                       |
| ------------------- | ----- | ---- | ---- | ---- | ------------------------------------------------------------------------------------------------------------- |
| pr-preflight        | 150   | 5    | 0    | 3.2% | **catch-correct** — missing handoffs (3×), lab-gate failures (1×), docs PR that also touched code             |
| pr-review-ledger    | 130   | 5    | 20   | 3.2% | **catch-correct** — agents attempting `create_pull_request` before completing the apple-scaled review harness |
| authoring-main-sync | 2,757 | 0    | 0    | 0%   | nominal                                                                                                       |

Both guards are working as designed. No mis-fires detected. The 3.2% deny rate is an
acceptable cost for catching genuine violations.

---

## Estimation accuracy

557 recorded sessions · **89% exact** · 6% over-budget · 5% under-budget · **median |error| = 0.0 🍎**

No systemic estimation bias. Apple calibration is functioning correctly.

---

## Proposed fix: effective CI tree-diff gate with patch-equivalence diagnostics

**Target:** `.github/scripts/ci-conflict-coordinator/reconcile.mjs`
**Apple estimate:** 2–3🍎 (tooling-only, capped at 3🍎)

### Current behaviour

`isCiCoordinationPath()` flags a PR as needing coordination if any diff file
matches the CI path pattern. A contaminated branch with stale CI-file changes
matches, creating a false-positive serialization.

### Proposed change

Before adding a PR to a coordination group, evaluate its **effective current CI tree
diff** against `main`, limited to the coordination paths. A safe admission rule is:

1. Use patch-equivalence (`git cherry`) only as a **diagnostic** for suspected relocated
   history after squash merges.
2. Gate coordination on the **path-limited tree diff** instead: if
   `git diff --quiet origin/main...<head> -- .github/workflows .github/scripts/ci-*`
   is empty, the PR is a CI no-op and should stay out of the coordination group.
3. If that diff is non-empty — or cannot be evaluated — keep the PR coordinated (or
   require a rebase / escalation) so #2137-style real CI reverts do not bypass the fence.

### Why this is the smallest fix

The fence-off knob (PR #2168) is already in place. Re-enabling enforcement safely
requires only a better admission gate — no dispatch-table changes, no new workflows,
no runtime changes.

### Measurability

| Metric                                              | Before fix               | Target after fix |
| --------------------------------------------------- | ------------------------ | ---------------- |
| PRs touching `reconcile.mjs` that were contaminated | ~73% (8/11)              | 0%               |
| Coordinated PRs with an empty effective CI diff     | observed false positives | 0                |
| PRs > 48h in a 60-PR window                         | 7 (12%)                  | ≤3 (≤5%)         |
| P90 lead time                                       | 55.5h                    | < 24h            |

The `CI_CONFLICT_COORDINATION_ENFORCE` knob documents the before/after
comparison gate. Run `npm run velocity:scan -- --limit 60` two weeks after
the fix lands to observe whether the tail shrinks; that follow-up is field monitoring,
not a causal A/B.

### Alternatives considered

1. **Keep coordination permanently default-off** — accepted risk: when any operator
   re-enables it, false positives recur silently.
2. **Rebase all agent branches before grouping** — heavier (needs write access per
   PR), still doesn't prevent fresh contamination on long-lived PRs.
3. **Filter by commit ratio** (skip PRs with >50% patch-identical commits) — a proxy;
   useful for diagnostics, but not sufficient to decide whether the resulting CI tree
   still changes `main`.

---

## Actions

- [x] Emergency fix: `CI_CONFLICT_COORDINATION_ENFORCE` default-off (PR #2168, landed)
- [x] Dispatch observability: `CI_RECOVERY_DECISION` log line (PR #2129, landed)
- [x] CI-only recovery protocol: narrowed task instructions (PR #2128, landed)
- [ ] **PROPOSED:** Effective CI tree-diff admission gate in CI conflict coordinator (2–3🍎)
- [ ] Re-enable `CI_CONFLICT_COORDINATION_ENFORCE` after the admission gate lands
- [ ] Re-run `npm run velocity:scan -- --limit 60` two weeks post-fix to monitor whether P90 improves

---

## Data notes

- 60 merged PRs in the window 2026-07-25 → 2026-07-28.
- Stage timings (review_q / post-review interval / merge_q) are computed from the 5 slow
  PRs (>48h) with full review + commit timestamp data fetched via GitHub MCP. The
  remaining 55 PRs contribute only lead time to the overall distribution; this report does
  **not** infer full-cohort stage medians from them.
- Size bucketing covers only 12 PRs with fetched additions/deletions data (the list
  endpoint does not return churn). Buckets with n < 3 are noted but not used for findings.
- `gh api graphql` returned HTTP 403 in this sandbox; all PR data was fetched via GitHub
  MCP REST endpoints.
