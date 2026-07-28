# Session Handoff: CI Recovery Loop Incident Auto-Close

## Date

2026-07-28

## Persona

CI Recovery Engineer (investigation + implementation)

## Systems touched

ci-recovery

## Apples

2🍎 exact

## What Was Done

Investigated CI recovery loop incident #2196, filed against PR #2184 ("Floor 2
industrial linework"). Found that CI recovery behaved correctly by design: it
exhausted its retry budget (2 attempts) after the Copilot agent took 49 minutes
to push a fix, and the incident was filed in a race condition — the fix was
authored at 12:10:07 but not yet visible to the 12:10:40 reconcile sweep.

Identified a missing feature: **`loop-incident-lib.mjs` had no `closeLoopIncident`
mechanism**. When a PR's CI later passed (all checks green on `aba0a581`), the
reconciler reached `ARM_AUTO_MERGE` with no way to auto-close the filed incident.
Incident #2196 stayed open indefinitely despite PR #2184 being fully healthy.

**Fix implemented:**

1. Added `closeLoopIncident` to `.github/scripts/ci-recovery/loop-incident-lib.mjs`:
   - Searches for open `ci-loop-incident`-labelled issues matching the PR's canonical title
   - If found, PATCHes the issue with `{ state: 'closed', state_reason: 'completed' }`
   - Idempotent: returns `{ action: 'not-found' }` when no incident exists
   - Ignores items that are pull_requests (same guard as `fileLoopIncident`)

2. Updated `.github/scripts/ci-recovery/reconcile.mjs`:
   - Imported `closeLoopIncident` alongside `fileLoopIncident`
   - Added a non-fatal `closeLoopIncident` call at the `ARM_AUTO_MERGE / QUEUE_MERGE_TRAIN`
     convergence point — after state is committed, before merge actions
   - Logs `loop-incident-closed pr=#N issue=#M` on success
   - Catches and logs any errors to stderr; failure never blocks the merge

3. Added tests:
   - 3 unit tests in `loop-incident-lib.test.mjs` for `closeLoopIncident`
     (closes, not-found, pull_request filtering)
   - 2 integration tests in `reconcile.test.mjs` (auto-closes incident on ARM_AUTO_MERGE,
     skips close when no incident)

All 152 reconcile tests, 17 loop-incident-lib tests, and 43 state tests pass.

## Key Decisions Made

**Race condition is not fixable directly.** The 12:10:07 → 12:10:40 timing was
accidental: Copilot authored the fix before the incident fired but hadn't yet
pushed. No code change can reliably close that window; CI recovery's design
(fingerprint-based progress, 30-min stale window, 2-attempt ceiling) is correct.

**Auto-close at convergence is the right fix.** The real gap was: once an incident
is filed, there was no automated path to close it when the PR became healthy.
This is what caused issue #2196 to stay open. The new `closeLoopIncident` call
at the ARM_AUTO_MERGE path closes the loop.

**Non-fatal close failure.** A failure to close the loop incident must never block
the merge. The try/catch logs the error to stderr and continues. CI Recovery
pipelines are designed to tolerate individual step failures gracefully.

**Use `pat` (write token) not `readToken` for both operations** — same pattern as
`fileLoopIncident`. The paginated list read is gated by issues:read which pat covers.

## What's Next / Blockers

- Issue #2196 is open on the repo; CI recovery's next sweep after this PR lands will
  pick it up. If reconcile runs for PR #2184 (now merged or at ARM_AUTO_MERGE) and
  sees issue #2196, it will close it automatically.
- The incident deduplication uses the title "CI recovery loop: PR #N" — this is stable
  and unique per PR. The `LOOP_INCIDENT_LABEL` scopes the paginate query to keep it fast.

## Retrospective

### Lessons Learned

- CI recovery loop incidents are purely reactive: filing is automatic when the retry budget
  is exhausted, but closing was entirely manual. The missing `closeLoopIncident` meant every
  incident required human triage even when the underlying issue self-resolved.
- The test for ARM_AUTO_MERGE in dry-run mode accepts either `dry-run would-arm-auto-merge`
  OR `wait pr=#42 admission=...` because the admission check state depends on whether
  `ci` and `Security checks` check runs are present. For live-mode tests that need to
  actually reach ARM_AUTO_MERGE, you must return passing check runs for both checks.
- The mock server in reconcile.test.mjs does EXACT match before prefix match for routes,
  so `GET /issues` and `GET /issues/42/comments` can coexist safely.

### Mistakes Made

- First test iteration had `check_runs: []` → hit `wait-admission` instead of ARM_AUTO_MERGE.
  Fixed by returning passing check runs for `ci` and `Security checks`.
