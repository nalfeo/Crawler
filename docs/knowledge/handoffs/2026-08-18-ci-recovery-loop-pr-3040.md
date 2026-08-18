# Session Handoff: CI recovery loop no-op Copilot reassignment (incident #3064 / PR #3040)

## Date

2026-08-18

## Persona

Producer → CI Recovery investigation

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

Investigated why the CI recovery automation made "no progress" after 2 dispatch attempts
on PR #3040 (issue #3064). Ruled out marker-parsing, `blockerFingerprint`, and the
`automationStallAction` stall/retry/exhaust arithmetic in `state.mjs`/`dispatch-table.mjs`
— all fired exactly as designed for PR #3040's timeline. PR #3040 itself has a genuine,
hard Floor-1 win-rate regression (76%, below the 90%/100% gates) plus a ~5.7h GitHub
Actions runner-queue delay on the `Merge gate` job — both real but not automation defects.

The actual deterministic defect: `reconcile.mjs`'s `dispatchCopilot` assign-copilot step
computed `actorIds` as the union of current assignees + Copilot's id and issued a single
`replaceActorsForAssignable` mutation. On a **redispatch** of an already-assigned PR
(exactly the R33 stale-automation-retry scenario that fired twice for PR #3040), Copilot
is already in `review.assignees`, so this union equals the current assignee set — a
no-op mutation that does not reliably signal GitHub's Copilot coding-agent platform to
start a fresh session. The PR then sits "dispatched" per automation bookkeeping while no
new agent session actually starts, until the 2-attempt ceiling exhausts and the loop
incident fires.

Fix: in `dispatchCopilot`, when Copilot is already an assignee, issue a targeted
unassign via the shared `removeIssueAssignees` helper from `issue-intake-lib.mjs`
(a `removeAssigneesFromAssignable` mutation scoped to Copilot's id only) immediately
before the existing single `replaceActorsForAssignable` reassign mutation — forcing a
genuine assignee-list transition. Removing only Copilot's id (rather than replacing the
full list with a Copilot-filtered copy) leaves any other assignees untouched and avoids
sending an empty `actorIds` array when Copilot is the sole assignee. First-time
assignment (Copilot not yet assigned) is unchanged (single mutation, as before). This
mirrors the existing remove-then-add pattern already used in `pr-ready-reviewer-guard.mjs`
(lines ~601-620, via `removeAssigneesFromAssignable`/`addAssigneesToAssignable`)
specifically to force a genuine reassignment edge for linked-issue repairs — strong
precedent this is a known, real GitHub platform behavior in this codebase.

Added a regression test in `reconcile.test.mjs` (`redispatch to a PR where Copilot is
already assigned forces an unassign-then-reassign edge`) that simulates a stale
automation retry where Copilot is already an assignee and asserts exactly one
`removeAssigneesFromAssignable` mutation targeting only Copilot's id, exactly one
`replaceActorsForAssignable` mutation that re-adds Copilot, and that the removal is
ordered before the reassignment. Ran the full `reconcile.test.mjs` suite (166 tests,
was 165) — all passing.

Verification: `node --experimental-vm-modules --test .github/scripts/ci-recovery/reconcile.test.mjs`
(166/166 pass), `node -c reconcile.mjs` (syntax), `npx eslint` on both modified files
(clean).

## Key Decisions Made

- Fixed the redispatch no-op at its source (the assignee-mutation call site) rather than
  adding a workaround in the stall/retry bookkeeping — the bookkeeping (R33/R34) is
  correct; the mutation it triggers was the defect.
- Reused the existing remove-then-add mutation pattern from `pr-ready-reviewer-guard.mjs`
  instead of inventing a new one, for consistency and because it's an already-proven fix
  for the same underlying GitHub platform quirk.
- Scoped this as a 2🍎 change: a single function's mutation sequence plus one regression
  test, no ledger required per rule #13.
- Plan was posted in-conversation on the issue/PR turn rather than via `gh issue comment`
  because this sandbox has no `gh` authentication and no MCP tool for posting a generic
  issue comment (only `engine-tools-reply_to_comment` for PR review-comment replies
  exists) — this repeats a previously-documented limitation (see
  `docs/knowledge/handoffs/2026-07-31-ci-recovery-pr2365-progressat-window.md`).

## What's Next / Blockers

- PR #3040 itself still needs its Floor-1 win-rate regression (76% vs 90%/100% gates)
  fixed by whichever agent/session owns that PR — that is a separate, substantial
  debugging task out of scope for this fix.
- Once this fix merges, the next stale-automation-retry redispatch on any PR should be
  observed to confirm Copilot actually starts a fresh session (no further deterministic
  test can prove GitHub's platform-side session-start behavior from this sandbox).

## Retrospective

### Lessons Learned

- The issue's four suggested defect categories (marker parser / permission grant /
  thread-resolution / mutation sequence) are boilerplate from
  `loop-incident-lib.mjs:133`, not a targeted hint — worth checking all four
  systematically rather than assuming one is pre-selected as the answer.
- `pr-ready-reviewer-guard.mjs`'s remove-then-add assignee pattern was the key precedent
  that confirmed a no-op replace mutation is a real, previously-encountered GitHub
  platform limitation in this codebase, not a hypothetical.

### Mistakes Made

- First draft of the new regression test's GraphQL mock had a redundant/no-op ternary
  (`gqlNoThreads.length ? gqlNoThreads() : gqlNoThreads()`) that always called the
  no-assignees helper, so it never actually exercised the "Copilot already assigned"
  path it was meant to test. Caught and fixed before running the suite by explicitly
  inlining a GraphQL response body with `assignees.nodes` containing the Copilot bot id.
  Lesson: when a mock branch is meant to differ from a shared helper's default, write
  the differing fields out explicitly rather than trying to special-case the helper call.

### Opportunities for Future Improvement

- Consider adding a lightweight assertion/lint that any `replaceActorsForAssignable` (or
  similar assignee-replace) mutation call site in `.github/scripts/` is checked for the
  "already assigned + redispatch" no-op case, since this is now a second occurrence of
  the same underlying GitHub API quirk (first in `pr-ready-reviewer-guard.mjs`, now in
  `reconcile.mjs`) — a shared helper could prevent a third recurrence elsewhere.
