# Session Handoff: Build-Expiry Merge Train

## Date

2026-07-14

## Persona

Producer -> DevOps Engineer

## Systems touched

ci-policy

## Apples

4 apples estimated, 4 apples actual

## What Was Done

- Replaced independent PR competition with an oldest-first six-slot recovery
  scheduler and a six-PR repository-managed train.
- Bound readiness to immutable PR-head checks and review state without expiring
  that evidence whenever `main` advances.
- Limited rebases to real merge conflicts and returned conflict/validation
  failures to recovery instead of repeatedly rewriting clean branches.
- Added cumulative candidate construction, fast plus targeted-security
  validation, prefix bisection, maximal-green-prefix promotion, and exact-SHA
  provenance.
- Suppressed managed-comment feedback loops and post-promotion reruns using a
  successful exact-SHA check attestation rather than a spoofable commit footer.
- Moved broad functional health validation to hourly `main` CI while preserving
  PR-head validation and preventing scheduled CI from deploying.
- Preserved all legacy auto-merge and blanket-rebase behavior while
  `MERGE_TRAIN_ENABLED=false`.
- Leased conflict-only rebases to the exact expected PR head and added bounded
  retry/recovery when a rebase job fails without changing that head.
- Made cumulative-conflict blocks self-healing when their predecessor leaves
  the train, and routed already-applied/no-op PRs through an explicit recovery
  path instead of stranding them.
- Bound promotion suppression to both a SHA-256 train fingerprint and the
  repository App identity that produced the check run.
- Bound candidate-validation results to the exact candidate fingerprint and
  repository App identity, with App-authenticated publication isolated from
  the job that executes candidate code.
- Moved auto-rebase PR triggers to trusted `pull_request_target` workflow code
  with an explicit default-branch checkout so PR-authored workflow changes
  cannot access the repository App key.
- Added flag-off label cleanup, trusted-promotion-only `main` CI suppression, a
  red-hourly-CI promotion circuit breaker, final pre-push reattestation, and a
  bounded post-promotion assertion that GitHub recorded every included PR as
  merged.

## Key Decisions Made

- `MERGE_TRAIN_ENABLED` is the only rollout switch for the coordinated behavior.
- Six active recovery owners count against the repair window; ready PRs leave
  that window and enter the train.
- Candidate validation runs `verify:fast` and `security:check`, not headless,
  E2E, coverage, or the full verification gauntlet.
- Non-monotonic prefix results advance from the longest validated prefix, and
  promotion moves every included PR head plus `main` in one atomic push.
- Only the PR represented by a synchronize event receives that trigger; other
  PRs admitted by the same sweep receive a neutral sweep trigger.

## Validation

- Automation harness: 91 tests total; 77 passed and up to 14 explicitly
  skipped for the known Windows `UV_HANDLE_CLOSING` subprocess shutdown
  assertion (skip count varies per run since the underlying libuv race is
  non-deterministic); 0 failed. Linux CI executes every subprocess assertion
  strictly, since the skip is gated on `process.platform === 'win32'`.
- `npm run verify:fast` passed.
- The 4-apple adversarial plan review, two-round code-review loop, and
  two-round multi-model review completed with all valid findings resolved.

## Third-wave Copilot review pass (independent-model validation)

An independent (non-primary-model) validation pass addressed the third wave
of 12 unresolved Copilot review threads:

- **Rollback completeness**: the rollback doc now requires removing
  `merge-train` from `main`'s required status checks (with a `gh api` example)
  before/alongside flipping `MERGE_TRAIN_ENABLED=false`, and clarifies that
  CI-recovery/auto-rebase resumption of freshness ownership is already
  automatic once the flag flips.
- **Flag-off cleanup starvation**: `router.mjs` now prioritizes PRs still
  carrying a train-owned label (`merge-train`, `merge-train-blocked`,
  `merge-train-noop`, `merge-train-validation-failed`) ahead of the
  `maxDispatchPerRun` cap during flag-off schedule sweeps, alongside any
  directly-triggered PR, so the flag-off cleanup sweep cannot strand an older
  labeled PR behind a backlog of newly-updated ones.
- **Stale handoff/PR metadata**: confirmed the authoritative local run
  (91 total / 77 pass / 14 skipped on Windows) matches this document and the
  PR description; no drift.
- **Main-health circuit breaker (current-SHA + fail-closed)**:
  `mainHealthAllowsPromotion()` now fetches the current `main` SHA explicitly,
  considers both scheduled and push-triggered CI runs (bounded lookback for
  push), excludes attested merge-train fast-path pushes, and fails closed
  (pauses promotion) whenever no full-CI evidence exists yet for the _current_
  `main` SHA, or that evidence is still pending — not just when a genuine
  failure is found.
- **Incident auto-close vs. train fast-path pushes**: `incident.mjs` fetches
  check-runs once per run and does not auto-close a real full-health incident
  on a train-promoted push success; it only closes on independently-verified
  non-fast-path CI success.
- **Bounded auto-rebase-failure retry/backoff**: an explicit
  `auto-rebase-failure` trigger for the still-current head now retries with
  exponential backoff (`60s * 2^(attempt-1)`, capped at 10 minutes, up to
  `REBASE_FAILURE_MAX_ATTEMPTS = 3`) instead of sitting idle until
  `REBASE_PENDING_TIMEOUT_MS` or escalating immediately.
- **Promotion-check shortcut gating**: the `ci.yml` and
  `security-review.yml` promotion-attestation shortcuts now require the exact
  string `vars.MERGE_TRAIN_ENABLED == 'true'`, so flipping the flag to false
  restores full CI/security-review execution on every PR instead of leaving a
  latent shortcut active.
- **Bisection reattestation before mutation**: the bisection-failure path in
  `merge-train/reconcile.mjs` now re-fetches the live `main` SHA and the live
  failing PR immediately before calling `blockEntry()`, and reuses the
  existing `promotionStaleReason()` check to detect staleness (main moved,
  head changed, no longer open, etc.) — including when `greenPrefixLength`
  is `0` — so a stale bisection result cannot mutate/label a PR that no
  longer matches the attested evidence; the next sweep rebuilds instead.
- **Concurrent-session reconciliation**: this pass discovered that another
  session (primary model) had independently pushed
  `cfc71f6cab3d1aa8b96d6709c8cd676c7e80fdb3` addressing the same threads
  (flag-off cleanup, rebase backoff, and a partial main-health fix) while this
  validation was in progress. Rather than force-pushing over it, the two were
  reconciled: the primary session's simpler/equivalent flag-off-cleanup fix
  and its exponential-backoff rebase-retry fix were kept as-is (verified
  correct and adopted); its main-health fix was completed, because it did not
  match current-`main`-SHA evidence and still failed _open_ on missing
  evidence, both required by the review thread.
- Automation harness after reconciliation: 110 tests total, 92 passed, 0
  failed, 18 skipped (same known Windows-only libuv teardown flake pattern).
  `npm run verify:fast` passed again after reconciliation.

## What's Next / Blockers

- Merge this PR with `MERGE_TRAIN_ENABLED=false`.
- Confirm the repository App still has the existing exact-promotion branch
  bypass and that `merge-train` remains a required check.
- Set `MERGE_TRAIN_ENABLED=true`, dispatch the router/train once, and observe a
  bounded production window for repair-slot movement, candidate validation,
  promotion, conflicts, duplicate dispatches, and workflow failures.

## Retrospective

- JavaScript function placement inside a nearby function can survive syntax
  checks while failing only on a rare state-machine branch; targeted lint and
  branch execution tests are required for workflow scripts.
- A commit-message footer is useful provenance for humans but is not a security
  attestation. Post-promotion suppression now requires a successful exact-SHA
  check run with an external fingerprint.
- Build-expiry savings remain safe when heavy PR evidence is immutable and the
  combined candidate receives a small integration plus security gate.
