# Goobers issue lifecycle comments

## Summary

Made Goobers issue progress self-contained instead of relying on GitHub's
cross-reference UI. Each eligible run now posts an idempotent start comment
before Goobers can claim the issue, and result diagnostics explicitly include
the canonical PR URL whenever a Goobers PR can be recovered. The actual
`goobers run` execution is also host-profiled so CPU, memory, and pressure
headroom are visible in the job summary and a raw JSON artifact.

## Systems touched

ci-policy

## Apples

3🍎 exact (2🍎 lifecycle comments + 1🍎 host profiling)

## What changed

- Added a fail-closed start-comment step after setup and immediately before
  `goobers run`. It revalidates that the selected issue is open, approved,
  unassigned, and dependency-unblocked, links the Actions run, and skips
  duplicate comments on reruns.
- Renamed the diagnostics step as the distinct result-comment step and retained
  its existing run, artifact, journal, source, and terminal-event diagnostics.
- Result comments recover the PR from fresh-run journal outputs/ref events,
  resume metadata, or an issue-linked open Goobers PR, then render the explicit
  canonical PR URL. Known PR-producing results fail actionably if no PR can be
  recovered.
- Result comments resolve the recovery issue before looking for a journal. A
  numeric recovery issue therefore always receives an idempotent terminal
  comment, even when Goobers emitted no `events.jsonl`; the comment reports
  unknown run IDs and no terminal events instead of orphaning the start comment.
- PR-resolution errors now override a stale successful display status, appear
  in a dedicated failure section in the durable comment, and only fail the step
  after the comment has been posted or patched.
- Failed or cancelled non-no-work runs release
  `goobers/status:in-review` when the claimed issue has no open Goobers PR and
  print the exact retry command. Resume metadata or an issue-linked open
  Goobers PR preserves ownership so partial work remains recoverable. Cleanup
  revalidates resume metadata against the current issue timeline; if the resume
  PR closed during the run and no replacement or no-work disposition exists,
  the claim is released with retry guidance.
- All issue-timeline PR lookups filter out external-repository cross-references
  before calling `gh pr view`; unreadable same-repository candidates emit a
  warning while lookup continues, but the lookup fails closed when no readable
  Goobers PR can establish a determinate state. This prevents duplicate fresh
  work and preserves claims when a possibly resumable PR cannot be inspected.
- Journal consumers sanitize JSONL line by line, warn about malformed records,
  and retain valid events so a cancellation-truncated final line cannot abort
  claim cleanup or the terminal result comment.
- Result diagnostics now use the same defaulted artifact name as the upload
  step, including issue-label and scheduled runs where no manual workflow input
  exists.
- Added deterministic workflow-contract assertions for step ordering,
  no-work/dependency gating, Actions URL rendering, PR recovery sources,
  explicit PR URL rendering, and rerun idempotency.
- Extended the existing ambient `.mjs` declarations for the shared Goobers
  lifecycle marker constants used by the workflow contract test.
- Bracketed the real `goobers run` invocation with the existing
  `.github/actions/host-profile` action after dependency/setup work. Both steps
  use the `goobers-run` label; the report runs immediately after Goobers with
  `always()` only when the identified start step succeeded, so failures emit
  telemetry while skipped/failed starts and no-work sweeps cannot produce
  phantom reports.
- The inherited host-profile report adds the existing job-summary table and
  uploads `host-profile-goobers-run-${{ github.run_attempt }}` containing
  `files/host-resources.json`.
- The result-comment marker is defined once and reused for body rendering and
  idempotent comment lookup.

## Verification

- `npm run test:unit -- tests/unit/goobers-run-workflow.test.ts --run` — 19
  tests passed, including focused no-journal terminal comments, PR-resolution
  failure rendering, failed-claim release/preservation, malformed-journal
  tolerance, fail-closed cross-reference filtering, marker reuse, and
  host-profile ordering/outcome gating.
- `npm run test:unit -- tests/unit/host-resources-lib.test.ts --run` — 42 tests
  passed.
- `node .github/scripts/validate-goobers-contracts.mjs` — 7 workflow schemas
  and 19 fixtures passed.
- `npm run typecheck` — passed.
- `npm run docs:check` — passed.
- `npx prettier --check .github/workflows/goobers-run.yml tests/unit/goobers-run-workflow.test.ts docs/knowledge/handoffs/2026-09-02-goobers-issue-lifecycle-comments.md`
  — passed.
- `git diff --check` — passed.
- `scripts/agent/preflight.sh` and `npm run verify:fast` could not run because
  `bash` resolves to WSL and this host has no installed WSL distribution or Git
  Bash. No tooling was installed solely to bypass that environment limitation.

## Follow-up

Observe the first live fresh and resumed Goobers runs after landing to confirm
the two issue comments render as expected with the hosted token.
