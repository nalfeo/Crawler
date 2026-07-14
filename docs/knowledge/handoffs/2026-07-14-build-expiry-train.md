# Session Handoff: Build-Expiry Merge Train

## Date

2026-07-14

## Persona

Producer -> DevOps Engineer

## Systems touched

ci-policy

## Apples

3 apples estimated, 3 apples actual

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

- Automation harness: 77 passed, 1 skipped only for the known Windows
  `UV_HANDLE_CLOSING` subprocess shutdown assertion; the skipped branch remains
  executable on Linux CI.
- `npm run verify:fast` passed.
- The 3-apple plan and two-round code-review loop completed with all findings
  resolved, including independent validation of the final security fix.

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
