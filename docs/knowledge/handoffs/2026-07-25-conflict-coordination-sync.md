# Handoff: Scope CI conflict coordination and synchronize authoring branches

## Date

2026-07-25

## Persona

Producer / DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 — tooling-only change spanning CI conflict coordination, authoring cadence,
and PR preflight behavior.

## Summary

Restricted the CI conflict coordinator to the surfaces it was created to
protect: `.github/workflows/**` and `.github/scripts/ci-*/**`. Persisted
coordination state now drops members that no longer touch those paths, and
reconciliation removes all four coordinator labels from stale or out-of-scope
PRs even when a trusted historical coordinator comment remains.

Added local authoring synchronization through `npm run sync:main`:

- session preflight fetches and safely rebases onto `origin/main`;
- the Copilot guard measures bounded intervals between active tool calls and
  attempts another sync after 30 active minutes;
- PR preflight makes a final safe synchronization attempt before reading the
  branch diff;
- dirty worktrees, detached HEADs, active Git operations, fetch failures, and
  conflicts produce non-blocking warnings;
- conflicting rebases are immediately aborted and no synchronization path
  pushes commits.

ADR 0075 records the scope and non-blocking synchronization policy. The 3🍎
review ledger records a separate-model plan review and a clean independent code
review.

## Files touched

- `.github/scripts/ci-conflict-coordinator/state.mjs` and tests — narrow path
  eligibility and filter persisted members by current eligible files.
- `.github/scripts/ci-conflict-coordinator/reconcile.mjs` and tests — discover
  every coordinator label footprint and remove stale labels deterministically.
- `scripts/agent/sync-main.mjs` and tests — safe fetch/rebase, evidence, active
  authoring accounting, conflict abort, and non-blocking results.
- `scripts/agent/preflight.sh` and `package.json` — session-start integration
  and `npm run sync:main`.
- `.github/extensions/copilot-guards/**` — active-authoring cadence guard and
  pre-publication self-healing/warnings.
- `AGENTS.md`, `.github/copilot-instructions.md`, and guard README — authoring
  cadence and validation-after-rebase guidance.
- `docs/knowledge/adr/0075-ci-conflict-scope-and-authoring-main-sync.md` —
  cross-system decision record.
- `docs/knowledge/review-ledgers/2026-07-25-conflict-coordination-sync.review-ledger.json`
  — required 3🍎 review evidence.

## Observe / verify

- Targeted Node suite: 66 tests, 65 passed, 1 skipped, 0 failed. The skip is the
  repository's existing Windows `UV_HANDLE_CLOSING` child-process condition in
  the coordinator integration harness.
- `npm run verify:fast`: passed.
- Independent code review (`claude-sonnet-4.6`): no validated findings.
- Real git fixtures prove a clean diverged branch rebases, dirty work is
  preserved, and a conflicting rebase aborts back to the original clean branch.
- Coordinator integration coverage proves an out-of-scope persisted member
  loses coordinated, leader, escalation, and order-wait labels.

## Unresolved issues

None.

## Recommended next steps

Allow the scheduled CI conflict coordinator to reconcile existing labels after
merge. Normal CI Recovery and Merge Train automation remain authoritative; no
manual lease or PR takeover is required.
