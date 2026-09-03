# Goobers issue lifecycle comments

## Summary

Made Goobers issue progress self-contained instead of relying on GitHub's
cross-reference UI. Each eligible run now posts an idempotent start comment
before Goobers can claim the issue, and result diagnostics explicitly include
the canonical PR URL whenever a Goobers PR can be recovered.

## Systems touched

ci-policy

## Apples

2🍎 exact

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
- Result diagnostics now use the same defaulted artifact name as the upload
  step, including issue-label and scheduled runs where no manual workflow input
  exists.
- Added deterministic workflow-contract assertions for step ordering,
  no-work/dependency gating, Actions URL rendering, PR recovery sources,
  explicit PR URL rendering, and rerun idempotency.

## Verification

- `npm run test:unit -- tests/unit/goobers-run-workflow.test.ts --run` — 12
  tests passed.
- `npm run typecheck` — passed.
- `npx prettier --check .github/workflows/goobers-run.yml tests/unit/goobers-run-workflow.test.ts docs/knowledge/handoffs/2026-09-02-goobers-issue-lifecycle-comments.md`
  — passed.
- `git diff --check` — passed.
- `scripts/agent/preflight.sh` and `npm run verify:fast` could not run because
  `bash` resolves to WSL and this host has no installed WSL distribution or Git
  Bash. No tooling was installed solely to bypass that environment limitation.

## Follow-up

Observe the first live fresh and resumed Goobers runs after landing to confirm
the two issue comments render as expected with the hosted token.
