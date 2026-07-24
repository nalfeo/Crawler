# Gate Copilot issue-assignment on `blocked_by` + auto-assign unblocked dependents

## Systems touched: ci-recovery

## Problem

`.github/workflows/issue-copilot-intake.yml` assigned Copilot and posted the
`@copilot` kickoff comment the moment any eligible issue was **opened**,
completely ignoring GitHub's native `blocked_by` issue-dependency graph. A
blocked issue (e.g. #1892, `blocked_by` #1851 + #1857) got a cloud agent
started prematurely against work that couldn't actually be done yet — the
maintainer had to manually unassign Copilot from #1892 after it prematurely
opened PR #1893.

## Fix

Two changes, both maintainer-approved up front:

**(A) Gate** — `intakeOpenedIssue()` (new, in `issue-intake-lib.mjs`) runs the
existing `issueIntakeEligibility()` check first, then fetches
`GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` and filters to
still-open entries via `openBlockingIssues()`. If any blocker is open, intake
returns `{assigned:false, reason:'blocked by open #N, ...'}` **before** ever
touching `runIssueIntake()` — no kickoff comment, no assignment mutation, no
GraphQL call at all.

**(B) Auto-assign on unblock** — `intakeUnblockedDependents()` (new) runs when
an issue **closes**: it fetches
`GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocking` (the closed
issue's dependents) and re-runs `intakeOpenedIssue()` on each one that is
still open and in the same repo. This makes the `blocked_by` graph fully
drive cloud execution hands-free — once #1851 and #1857 both merge/close,
#1892 gets auto-assigned by this sweep with no human action.

The trigger workflow now listens on `types: [opened, closed]` instead of just
`[opened]`, and `issue-intake.mjs` branches on `payload.action` to call
`intakeOpenedIssue` or `intakeUnblockedDependents` accordingly. The exact
pre-existing `intake-complete issue=#N opener=@X assignee=@Y comment=Z`
success log line is unchanged for the opened path. The closed path logs one
`unblock-dependent issue=#N ...` line per dependent plus a summary
`unblock-sweep closed=#N dependents=X assigned=Y errors=Z` line, and sets
`process.exitCode=1` only if any dependent hit a genuine error (not a benign
skip).

## Design notes / review-driven changes

- **Fail loud on dependency-fetch failures.** `getBlockedByDependencies()` /
  `getBlockingDependents()` never swallow API errors or unexpected response
  shapes — a network/API failure propagates as a thrown error, never as an
  assumed "no blockers". Both functions delegate directly to the existing
  `paginate()` helper in `github.mjs`, which already throws
  `Expected paginated array from ${path}` on a non-array response and fully
  paginates beyond 100 entries (this replaced an earlier draft that used a
  single `request()` call with `per_page=100` and silently coerced a
  non-array response to `[]` — flagged in code review as both a silent
  truncation risk for >100-entry dependency lists and a fail-loud contract
  violation; using `paginate()` fixes both in one change).
- **Live re-check before assignment.** `runIssueIntake()` now throws a new
  exported `IssueNoLongerOpenError` if the issue's live GraphQL state is no
  longer `OPEN` at assignment time — guarding the moment-in-time race where
  an issue closes between the `blocked_by`/dependent snapshot check and the
  actual assignment mutation. `intakeUnblockedDependents()` special-cases
  this error via `instanceof` and records it as a benign
  `{assigned:false, reason:'dependent closed during processing'}` skip
  rather than an `{error}` entry, so it never spuriously flips the workflow
  run red. Confirmed this new guard doesn't regress
  `nightly-balance-issue.mjs`, the other caller of `runIssueIntake` (via an
  injectable `intakeFn`) — it already wraps intake calls in try/catch with
  rollback logic.
- **Accepted, documented risk:** the kickoff-comment idempotency check
  (`hasIntakeRequirementComment`) is read-then-write, not atomic. Two
  near-simultaneous unblock-sweep runs (e.g. two blockers of the same
  dependent closing within seconds of each other) could theoretically both
  observe "no marker comment yet" and both post a kickoff comment. This is
  low-probability, non-data-corrupting (the assignment mutation itself is
  idempotent), and GitHub issue comments have no compare-and-swap primitive
  to close this gap without introducing a separate lock resource — accepted
  as-is per plan review, not fixed in this PR.
- **`incident.mjs` deliberately NOT touched.** CI-recovery INCIDENT issues
  describe an already-broken PR/run and are inherently unblocked by
  definition — gating them on `blocked_by` would add surface area with zero
  benefit. Explicit product decision, not an oversight.
- **#1892 was left untouched.** It's already unassigned (maintainer manually
  reverted a premature assignment). The fixed automation will pick it up on
  its own once #1851 and #1857 both close/merge — do not manually re-assign.

## Review harness

3🍎 tier (CI/automation tooling, capped). Ledger:
`docs/knowledge/review-ledgers/2026-07-24-gate-copilot-assignment-blocked-by.review-ledger.json`.

- **Plan review** (gpt-5.4, high effort): `approved_with_changes`,
  `plan_divergence: minor`. Affirmed the wrapper-function design
  (`intakeOpenedIssue`/`intakeUnblockedDependents` around `runIssueIntake`)
  over gating inside `runIssueIntake` directly, since the closed-issue sweep
  needs per-dependent branching and error isolation a single gated function
  can't provide. Two concerns raised; one (stale-snapshot race) fixed via
  `IssueNoLongerOpenError`, the other (comment non-atomicity) accepted as
  documented above.
- **Code review round 1** (claude-sonnet-4.6): 3 findings (fail-loud `[]`
  coercion, race misclassified as error, missing pagination) — all fixed.
- **Code review round 2** (claude-opus-4.7): independent fresh pass, clean —
  no new issues.

## Validation

This worktree has **no `node_modules`**, so `npm run verify`/`npm test`/
`npm ci` all fail on missing deps (pre-existing env quirk, unrelated to this
change). Validated instead via:

- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs` — 25/25
  pass (17 pre-existing + 8 new/updated for the blocked_by gate and unblock
  sweep, including error-propagation and race-as-skip cases).
- `node --test .github/scripts/ci-recovery/*.test.mjs
  .github/scripts/nightly-balance-issue/*.test.mjs` — 311 pass, 12 skipped
  (env-gated), 1 file failure (`router.test.mjs`) that is a pre-existing
  `Cannot find package 'yaml'` module-resolution failure caused by the
  missing `node_modules`, unrelated to this change (confirmed via `git
  diff --stat`: `router.test.mjs` is not touched by this PR).
- Review ledger: `node scripts/agent/review/cli.mjs validate <path>` → valid
  3-apple ledger.
- `npm run verify:pr-prereqs` / `npm run verify:fast` were **not** run — both
  require `node_modules`, which is absent in this worktree per the task's
  explicit env-quirk guidance. CI enforces lint/typecheck/full verify on the
  PR.

## Files changed

- `.github/scripts/ci-recovery/issue-intake-lib.mjs` — new
  `getBlockedByDependencies`, `getBlockingDependents`, `openBlockingIssues`,
  `intakeOpenedIssue`, `intakeUnblockedDependents`, `IssueNoLongerOpenError`;
  `runIssueIntake` gained a live-state guard.
- `.github/scripts/ci-recovery/issue-intake.mjs` — rewritten to branch on
  `payload.action` (`opened` vs `closed`).
- `.github/workflows/issue-copilot-intake.yml` — trigger
  `types: [opened]` → `[opened, closed]`; step renamed.
- `.github/scripts/ci-recovery/issue-intake.test.mjs` — 8 new tests.
- `docs/knowledge/review-ledgers/2026-07-24-gate-copilot-assignment-blocked-by.review-ledger.json`
  — new review ledger.
- `docs/knowledge/metrics/apples/2026-07-24-gate-copilot-assignment-blocked-by.json`
  — apple-metrics: estimated 3, actual 3, verdict exact.
