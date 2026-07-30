# 2026-07-27 — CI Recovery: make the @copilot dispatch decision observable

## Systems touched: ci-policy

## Summary

Observability-only instrumentation of the CI-recovery dispatch decision. On
every reconcile pass, `reconcile.mjs` now emits **one structured
`CI_RECOVERY_DECISION {json}` line** into the append-only GitHub Actions
workflow run log at each point where a dispatch-table row is finally selected
(the early `selectEarlyAction` short-circuit and the terminal
`selectTerminalAction` decision). The line records what was decided and the
inputs that drove it, so a skipped `@copilot` dispatch is diagnosable from a
single log line instead of hours of forensics.

**Apple estimate:** 3🍎 (declared at kickoff; tooling/CI-only). Actual: 3🍎.

**Velocity classification:** _unmeasured_. This does not speed anything up by
itself; it makes the real cause of dispatch stalls findable. No delivery
improvement is claimed.

## Why (the blind spot)

A velocity analysis found a handful of PRs stall 8–12h (median 1.21h), all
sharing a multi-hour gap between the Copilot reviewer posting findings and
anything acting on them. On PR #2078 the recovery automation was demonstrably
alive (it posted `crawler-review-request:v1` + `crawler-ci-state:v1`) but
**never posted a `crawler-ci-task:v1` comment** — it silently declined to
summon `@copilot`, and 6.81h later a human had to type the mention by hand.

The decision path is invisible because `crawler-ci-state:v1` is a **single
comment updated in place** — every reconcile overwrites it, destroying the
history. #2078's surviving state showed only `attempt:0` (never dispatched)
_after_ the human resolved it, saying nothing about what happened at decision
time. Stale-lease was ruled out (lease TTL 30min + 5min grace can't explain a
6.8h gap). The actual bug — _why_ dispatch was skipped — was undiagnosable.

## What landed

Commit 1 — observability (`feat(ci-recovery): make the copilot dispatch decision observable`):

- **NEW `.github/scripts/ci-recovery/decision-log.mjs`** — a pure logging
  module. Exports `DECISION_LOG_MARKER = 'CI_RECOVERY_DECISION'`,
  `formatDecisionLog(record)`, `buildEarlyDecisionRecord(...)`,
  `buildTerminalDecisionRecord(...)`, `terminalTaskCommentIntent(action, live)`.
  No side effects, no API calls, no I/O beyond returning strings.
- **`reconcile.mjs`** — added `buildDecisionCommon()` and two log points:
  - early: inside `if (earlyRow)`, right after `selectEarlyAction(earlyCtx)`.
  - terminal: after the terminal dispatch-table row is finalized (a
    `selectedTerminal = {row, ctx, pass}` snapshot is taken in the max-2-pass
    loop so the log uses the exact ctx that selected the final row), before the
    `WAIT_ADMISSION` branch handler.
    The lines are emitted via `process.stdout.write` only.
- **`review-wake-bridge.mjs` + `.test.mjs`** — `decision-log.mjs` registered in
  `PROTECTED_WORKFLOW_PATHS` (source Set + test mirror array), because it now
  enters `reconcile.mjs`'s privileged import closure and the review-wake bridge
  verifies every such file against the merge base before privileged execution.
- **`decision-log.test.mjs`** (NEW, 15 tests) + 3 topology integration
  assertions and a `parseDecisionLines()` helper in `reconcile.test.mjs`.

Commit 2 — main unblock (`fix(ci): unbreak main — sweep-budget latent-backlog test expected stale count`):

- **`sweep-budget.test.mjs`** — a stale test, unrelated to observability. The
  emergency router fix `492bb4be8` ("unstarve the repair window") intentionally
  excluded externally-blocked labels (incl. `merge-train-blocked`) from
  `eligibleTrainRecoveryPulls`, so `countLatentBacklog` now correctly returns 2
  not 3. That commit added `router.test.mjs` coverage but missed this
  transitively-dependent test, which had turned **main red on every run since**
  (confirmed via `gh run list --workflow ci.yml --branch main`: 5 consecutive
  failures at the `Guard + review-ledger tests` step). Corrected the expectation
  to 2 with a documented comment. Test-only; does not touch
  `router.mjs`/`sweep-budget.mjs`, so no collision with in-flight #2108/#2101
  (which touch `router.*`/`merge-train/*` only).

Commit 3 — code-review findings (`refactor(ci-recovery): address code-review findings on decision log`):

- **`staleRetryCeilingReached`** added to the terminal record. The task required
  logging "any cap/ceiling that was hit"; the substantive terminal ceiling is the
  stale-automation retry exhaustion (`automationStallAction` returns `'release'`
  only once `stallAttempt >= 2`, see `state.mjs`). The flag is re-derived purely
  from `ctx.stallAction === 'release'` — already in the snapshot, so **no new
  plumbing and no behavior change**.
- **`sanitizeTrigger`** bounds `trigger` / `stateTrigger` (both free-form: the
  former from `workflow_dispatch.inputs.trigger`, the latter from persisted
  state). It coerces to a string and truncates to 120 chars. The raw value is
  **deliberately preserved** rather than collapsed to an enum — the whole
  diagnostic point of `trigger` is telling a review event from the sweep from a
  manual/anomalous dispatch, and an allowlist would hide exactly the anomaly a
  stall investigation is chasing. `JSON.stringify` already prevented injection;
  this only removes the unbounded-length risk.
- 4 new `decision-log.test.mjs` cases (ceiling true-only-on-`release`,
  `sanitizeTrigger` null/short/coerce/truncate, terminal-record sanitization).

## Decision-line shape (what you get, and the alternatives rejected)

**Chosen shape:** one `console`-visible `CI_RECOVERY_DECISION {json}` line per
final dispatch decision, into the workflow run log (already retained), carrying
only in-memory data. Fields: `stage` (early|terminal), `pr`, `headSha`, `ts`,
`trigger` (review-event vs `*/10` sweep), `row`, `action`, `taskComment` intent
(`planned`|`dry-run`|`not-applicable`), and the determinants (`blockerCount`,
`blockerKinds`, `owner`, `status`, `stateAttempt`, `labelExists`,
`shepherdLeaseExpired`, merge-train ownership, `staleRetryCeilingReached`
(the stale-automation retry exhaustion ceiling), `fingerprint`,
`terminalPass`). `trigger` and `stateTrigger` are bounded (coerced to string +
truncated to 120 chars) but keep their raw value so an anomalous trigger stays
visible.

**Alternatives rejected:**

- _Append-only PR comment / new state comment_ — violates the "no new always-on
  comment" constraint (comment noise is a cost) **and** adds writes to a hot
  path already hitting HTTP 403 secondary-rate-limit throttling.
- _Run artifact upload_ — heavier, needs a separate fetch step to read, and adds
  a step to the hot path; the run log is already retained and greppable.
- _Reviving per-decision state history (versioned state comments)_ — the most
  faithful record but the worst fit: N extra API writes per pass on the exact
  path under rate-limit pressure.

The log-line shape is the lightest thing that makes the decision diagnosable
with zero added API calls and zero new comments.

## How to diagnose a stalled PR after this lands

1. Find the CI Recovery workflow run(s) for the PR's stall window: the
   `ci-recovery-router` workflow (triggered by `pull_request_review` and the
   `*/10` sweep).
2. Open the run log and grep for `CI_RECOVERY_DECISION`.
   - **A line is present** → read `action` + `taskComment`. If
     `action` is not `dispatch-copilot` (or `taskComment` is `not-applicable`),
     the determinant fields on that same line say _why_ (e.g. `owner` already
     held, `status`, `shepherdLeaseExpired:false`, a cap that was hit, blocker
     kinds). That is the one-line answer.
   - **No line at all** → the run exited at a **pre-table guard** before reaching
     a dispatch-table decision (mode=off, draft PR, fork, orphaned-label
     cleanup, opt-out, or closed PR). Those guards log their own
     `skip …` / `cleanup …` reason lines — grep those. (By design, only runs
     that reach a _final dispatch-table decision_ emit a `CI_RECOVERY_DECISION`
     line; pre-table guards are self-describing.)

## Constraints honored

- **Observability only** — no dispatch behavior, caps, or decision-table
  changes. The log points read context already computed and print it; no new
  branching, early returns, or state mutation.
- **No new PR comment**; **no hot-path API calls** (logs in-memory data only).
- **No injection** — records log only enums/counts/`kind` strings, never blocker
  summaries/URLs; `JSON.stringify` escapes control chars.
- Unit coverage lives in `.github/scripts/ci-recovery/*.test.mjs` (run by
  `npm run test:guards`), not in `tests/unit/*.ts` (avoids the TS7016
  untyped-.mjs import failure fixed in #2067).
- Branched from `origin/main`; staged **explicit paths** only; read `git status`
  before every commit (shared-worktree hazard).

## What I learned about _why_ dispatch was skipped

Nothing yet points at a specific dispatch-table row — and that is exactly the
point. The instrumentation is what _enables_ the next diagnosis. The concrete
finding this session is the **blind spot itself**: the in-place-overwritten
state comment means the historical decision that mattered (PR #2078 @ 04:40)
was already destroyed by the time anyone looked. `attempt:0` in the surviving
state proves "never dispatched" but not "why". With `CI_RECOVERY_DECISION`
lines, the next occurrence is a one-line lookup.

If the bug recurs and a decision line shows `action:dispatch-copilot` with
`taskComment:planned` but no subsequent `assigned copilot pr=#N` line, the fault
is in the POST/assignment step, not the decision. If it shows a non-dispatch
action, the determinant fields identify the responsible guard/row — feed that
back into a targeted fix (separate PR; do not fix in the observability PR).

## Validation / observe-before-done

- `npm run test:guards` → 1816 pass / 0 fail (includes the 15 new
  `decision-log` unit tests + 3 `reconcile` topology assertions + the corrected
  `sweep-budget` test).
- `npm run verify:fast` → pass.
- **Direct emission confirmed locally**: the target `reconcile.test.mjs`
  subprocess topology tests skip on Windows (known UV*HANDLE_CLOSING teardown
  crash; they run on Linux CI). To confirm line \_content* locally I used a
  temporary stderr probe and observed real lines:
  `stage:"terminal", row:"R26", action:"wait-admission",
taskComment:"not-applicable"` and `stage:"early", row:"R03",
action:"skip-active-shepherd", taskComment:"not-applicable"`, both with all
  determinant inputs populated. The probe was reverted (verified no residue).

## Follow-ups / notes

- In-flight PRs #2108 (anti-starvation rotation) and #2101 (liveness cadence)
  touch `router.*`/`merge-train/*`; this PR does not, so no collision.
- The `sweep-budget` stale-test breakage is a symptom of a coverage gap:
  `sweep-budget`'s latent-backlog count transitively depends on `router.mjs`
  backlog semantics but its test was not updated when those semantics changed.
  Worth a future guard that ties the two together, but out of scope here.
