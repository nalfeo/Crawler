# Handoff: CI harness D3 first-class repair transition

## Date

2026-07-26

## Persona

Producer / DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 3🍎.

## Summary

Landed the D3 repair-transition gap in the CI recovery router without collapsing
review wake into repair wake.

- Added `isRepairWakeEligible(...)` to
  `.github/scripts/ci-recovery/router.mjs`. A PR only qualifies when it still
  carries `ci-recovery-waiting`, has **no** owner lease label, has **no**
  waiting-transition label, and its persisted recovery state is already
  `owner=none,status=idle`.
- Reused the existing reconcile repair path instead of adding a second
  dispatcher. Idle waiting PRs can now re-enter repair-window sweeps and flow
  back through the existing exact `@copilot` repair dispatch + owner-lease
  acquisition logic.
- Kept genuine waiting PRs excluded. A waiting label by itself still stays
  hidden from broad sweeps; only the converged idle/no-owner repair state can
  re-surface it.
- Kept review wake separate. `shouldRequestReview(...)` remains unchanged and
  still returns `null` for blocked PRs.
- Updated the D3 characterization so the fixture now encodes the intended split:
  **review wake stays null** while **repair wake becomes eligible** for the same
  broken idle waiting PR.
- Inspected the dependency context from #1856 / #1858 / superseded PR #1923 and
  intentionally absorbed only the still-missing D3 behavior already absent on
  current `main`, rather than replaying the older branch wholesale.

## Files touched

- `.github/scripts/ci-recovery/router.mjs`
- `.github/scripts/ci-recovery/router.test.mjs`
- `.github/scripts/ci-recovery/characterization.test.mjs`
- `.github/scripts/ci-recovery/characterization/reconcile-decision-fixtures.json`
- `docs/knowledge/review-ledgers/2026-07-26-ci-harness-d3-repair-transition.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-26-ci-harness-d3-repair-transition.md`

## Observe / verify

Deterministic evidence:

- `node --test .github/scripts/ci-recovery/router.test.mjs .github/scripts/ci-recovery/characterization.test.mjs`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`

What the tests prove:

- The D3 characterization flipped from "no wake" to "repair wake eligible"
  while review wake remains null.
- Genuine `ci-recovery-waiting` PRs remain excluded, including direct events.
- Idle/no-owner waiting PRs re-enter both flag-off sweeps and train repair-window
  sweeps.
- Existing reconcile invariants remain covered unchanged, including exact
  `expected_head_sha` / `expected_base_ref` binding and
  `stale-automation-exhausted` / duplicate-progress no-storm behavior.
- **End-to-end subprocess test** (`runFromEnv hydrates waiting/no-owner
  candidates and dispatches repair wake via schedule`): exercises the complete
  production HTTP path — the mock server returns the PR without an injected
  `recoveryState`, the router fetches comments via the API, parses the idle
  state, and dispatches reconcile. This is the production execution path that
  pure unit tests (which inject `recoveryState` directly) cannot cover.

Live observation status:

- The repair-wake unit tests and the new `runFromEnv` subprocess integration
  test provide deterministic end-to-end evidence that the production path
  works. The reviewer noted that the issue's acceptance criteria also require a
  **live production observation** (a real broken, idle PR receiving a repair
  comment + acquired lease on the next scheduled sweep).
- No live PR in the exact precondition state (`ci-recovery-waiting` + persisted
  `owner=none,status=idle`) was available at the time of this session. The open
  waiting PRs inspected (e.g. #2057, #2066, #2023, #1996, #1972) were all
  persisted as `owner=none,status=waiting,trigger=admission-wait`, not idle
  repair states. Open PRs with idle state (e.g. #2016, #1923, #2022, #1939)
  did not carry `ci-recovery-waiting`.
- **Issue #1859 remains open** pending live production observation. The issue
  should be closed by a maintainer only after observing a real broken, idle
  `ci-recovery-waiting` PR being repaired on the next scheduled sweep after
  this fix is deployed.

## Follow-up

1. After this patch is deployed, monitor the next real PR that reaches
   `ci-recovery-waiting` with persisted `owner=none,status=idle` for:
   - one `@copilot` repair task comment dispatched on the next sweep, and
   - one acquired automation owner lease,
     with no repeated storming once progress fingerprints stop changing.
2. Once that production observation is made, close issue #1859 with a link to
   the evidence.
