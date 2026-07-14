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
