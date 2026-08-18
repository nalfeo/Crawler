# Session Handoff: CI recovery loop fix for PR #2613 (issue #2619)

## Date

2026-08-01

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎 exact

## What Was Done

Investigated the CI recovery loop incident filed against PR #2613 and implemented two targeted fixes:

1. **`nightly-velocity-issue.mjs`**: Changed the closing-reference instruction text from `Closes #${issueNumber}` to `Closes nalfeo/Crawler#${issueNumber}`. This is the code change PR #2613 was making and supersedes that PR. Using the fully-qualified owner/repo form is clearer for implementation agents and matches the pattern the reviewer in PR #2613 wanted to enforce.

2. **`reconcile.mjs` task comment instruction** (line ~3140): Added explicit guidance for PR body (description) updates — specifically directing dispatched sessions to use `PATCH /repos/{owner}/{repo}/pulls/{prNumber}` via the GitHub REST API rather than `gh pr edit`. The prior wording only said "use GitHub API tools (not gh CLI)" which was ambiguous and failed in practice when sessions lacked the right tool.

3. **`nightly-agent-issues.test.mjs`**: Added a focused regression test asserting that `buildVelocityIssueBody(issueNumber)` includes the fully-qualified closing reference `Closes nalfeo/Crawler#${issueNumber}` and does NOT include the bare short form `Closes #${issueNumber}`.

No runtime gameplay code was changed. No TypeScript changes. Tests: 3 nightly-velocity-issue tests pass, 163 reconcile tests pass, 59 state tests pass.

## Key Decisions Made

**Why the automation did NOT have a code defect:** After reviewing reconcile.mjs, state.mjs, dispatch-table.mjs, marker parsing, and the actual workflow run logs, I found the automation worked correctly. `isDuplicateDispatch=true` at stateAttempt=2 is intentional — the system correctly detected no progress and filed a loop incident (R34). `normalizeThreadComments`, `shouldResolveThread`, `TRUSTED_BOT_LOGINS`, and `priorUnresolvedReplyByThread` all operated correctly.

**Root cause of the loop:** PR #2613 included `Fixes #2612` in its body. Issue #2612 has the `human-approval-required` label (as do all nightly velocity issues). GitHub's `closingIssuesReferences` GraphQL API detected this and `requiresHumanApproval` returned true. The review thread from `copilot-pull-request-reviewer` correctly flagged this as an incorrect closing link. Dispatched copilot sessions tried to update the PR body but lacked the tool/permissions. After 2 attempts at the same fingerprint, the automation exhausted the retry budget and escalated.

**Fix scoping decision:** Rather than adding complex reconciler logic to strip closing references from PR bodies (which would require label-history checks and careful scoping), the smallest correct fixes are:

1. Fix the source template so future nightly issues emit clearer instructions (qualified closing reference)
2. Improve the task comment to give more specific API guidance for PR body edits

**Alternatives not taken:** Adding reconciler-side PR body mutation logic. This would be a larger change with non-trivial surface area for regressions. The instruction improvement is sufficient for sessions that have API access; for sessions that genuinely have no PATCH permission, the human-escalation path (already wired) is the correct outcome.

## What's Next / Blockers

- PR #2613 can be closed as superseded by this fix.
- Reply to PR #2613's review thread `#discussion_r3695451340` with `✅ Not applicable: closing reference fixed in nightly-velocity-issue.mjs in main; PR #2613 superseded`.
- Future: if multiple loop incidents indicate dispatched sessions consistently can't do PR body updates, consider adding a reconciler-side mutation as described above.

## Retrospective

### Lessons Learned

- The `automationStallAction` returning `release` at `attempt >= 2` is intentional and correct — if a dispatched session makes no progress in 2 attempts at the same fingerprint, escalation is the right call. The automation is working as designed.
- `normalizeThreadComments` strips non-marker recovery replies from the comment digest intentionally, so the fingerprint stays stable across failed recovery attempts. This is critical for loop-incident detection.
- `listClosingIssues` uses GitHub's `closingIssuesReferences` GraphQL which detects ALL forms of closing keywords (`Fixes`, `Closes`, `Resolves`) in both short (#N) and fully-qualified (owner/repo#N) forms. Changing the instruction to use the qualified form does NOT prevent `human-approval-required` propagation if the closing link is valid — but it does help implementation agents use a consistent, unambiguous format.
- The `verify:fast` command fails in this sandbox environment because `npx tsc` resolves a stub package instead of the project's TypeScript. Use `./node_modules/.bin/tsc --noEmit` when available, or run `node --test` directly.

### Mistakes Made

- Spent significant time investigating complex reconciler mutation paths before concluding the automation worked correctly and the fix is simpler. Should have checked `isDuplicateDispatch=true` in the CI logs first to confirm automation-correctness before deep-diving into code paths.

### Opportunities for Future Improvement

- If dispatched sessions consistently can't update PR bodies (due to permission scoping), add reconciler-side PR body stripping logic triggered at R34. The reconciler has CRAWLER_CI_PAT with write access and could strip closing references to `human-approval-required` issues when review threads flag them as incorrect and prior attempts failed.
- Add a test in reconcile.test.mjs that verifies the task comment body includes the PR body update API guidance when `priorUnresolvedReplyByThread` is set.
