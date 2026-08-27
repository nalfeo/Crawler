# Handoff: CI recovery follow-up backlog issue handling

## Systems touched

ci-recovery, agent-os

## Apples

Estimated: 3. Actual: 3.

## Summary

Diagnosed PR #3121's CI recovery loop from the linked review thread and workflow run 32230811755. Recovery reached the stale-automation exhaustion path correctly, but it kept delegating a deterministic external mutation — filing an unassigned follow-up backlog issue for linked source issue #3120 — to Copilot repair sessions that did not have issue-create/PR-body update tools.

Fix:

- Added a strict trusted-review parser for follow-up backlog issue requirements that:
  - requires the root comment to come from Copilot reviewer/trusted association,
  - requires explicit follow-up backlog issue wording,
  - requires explicit unassigned/not-assigned-to-Copilot wording,
  - fails closed when any referenced issue is not one of the PR's closing issues,
  - fails closed on cross-repository closing issues so a `other/repo#N` reference never resolves to the same-numbered local issue.
- Added a managed follow-up backlog marker for idempotency.
- Taught `reconcile.mjs` to create or reuse an open automation-labelled follow-up issue with no assignees, reply in the exact review thread with `✅ Addressed in <head>`, and resolve the thread without redispatching Copilot.
- Hardened the new issue/reply/resolve mutations with catch-and-log behavior so transient GitHub failures do not crash the reconciler before normal terminal handling.

## Verification

- `bash scripts/agent/preflight.sh`
- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npx prettier --check .github/scripts/ci-recovery/markers.mjs .github/scripts/ci-recovery/issue-intake-lib.mjs .github/scripts/ci-recovery/issue-intake.test.mjs .github/scripts/ci-recovery/reconcile.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run review:grade -- record docs/knowledge/review-ledgers/2026-08-19-ci-recovery-followup-backlog.review-ledger.json --model gemini-3.6-flash --implementer copilot-coding-agent --file /tmp/ci-recovery-grade-reply.md --packet /tmp/ci-recovery-grade-packet.json`
- `code_review` — clean after completing the ledger.
- `codeql_checker` — no analyzable CodeQL language changes detected.

## Unresolved issues

- Could not post the requested pre-code plan comment to issue #3147 from this session: `gh issue comment` was unauthenticated and no issue-comment creation tool was available. The plan was recorded through `report_progress` and the PR description should include the same high-level summary.

## Recommended next steps

- Let CI exercise the live GitHub API path after merge.
- If another external-action review-thread class appears, add a similarly strict trusted parser and deterministic reconciler action rather than broad natural-language execution.
