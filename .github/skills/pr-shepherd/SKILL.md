---
name: pr-shepherd
description: >-
  Drive open GitHub pull requests to a clean squash-merge in the Crawler repo.
  Use when asked to "shepherd" a PR, run a "PR shepherding loop", drive/babysit
  PRs to merge, clear the open-PR queue, or unblock a stuck PR through CI and
  review. Covers discovering in-scope PRs (open, no active session, or owner
  idle >30m), launching one child session per PR in parallel, diagnosing and
  fixing REAL CI failures, resolving review threads, and arming auto-merge per
  the repo merge policy.
---

# PR Shepherd

Take one or more open PRs from "open" to "squash-merged into `main`" without hand-holding: discover what is in scope, fix the real blockers (CI failures, unresolved review threads), and let GitHub auto-merge finish the job. **No human review is required to merge this repo** — never blame a "review block" without explicit proof from `gh pr merge` output.

This skill has two modes. Pick based on the request:

- **Not the default publication path.** A normal implementation session releases
  its ready-for-review PR immediately so CI Recovery can assign cloud Copilot.
  Start a local Shepherd only when the human explicitly pre-declared local
  ownership or when coordinating a later takeover after the original session
  has released the branch.
- **Refresh behavior (Coordinator shorthand):** if the user says 'refresh', treat it as: repoll open PRs, determine takeover-ready PRs, and immediately launch shepherd sessions for all in-scope PRs in that pass.

- **Coordinator** — "shepherd the open PRs" / "run a shepherding loop". You orchestrate: discover in-scope PRs and launch one child session per PR in parallel, then relay results. **One PR = one child session, always.** Tackle _every_ PR through its own session — including merge-conflict resolution, rebases, and "quick" CI fixes. Do **not** fix PRs in the coordinator session yourself; never check out a PR branch or open a temp worktree to resolve a conflict locally. The only exception is when a child session has tried and genuinely cannot proceed — then take over directly. Resist the temptation to hand-fix the "easy" ones; consistency keeps the loop parallel and lets you keep coordinating.
- **Shepherd** — "shepherd PR #N" / a child session spawned by the coordinator. You own getting that one PR merged end-to-end.

> Detailed command recipes, the exact session-tool parameters, the SQL tracking
> schema, and every gotcha live in
> [`references/playbook.md`](references/playbook.md). Read it before launching
> sessions or touching `gh` for anything non-trivial.

## Crawler merge facts (authoritative)

- **Merge command:** `gh pr merge <n> --auto --squash`. This enables GitHub auto-merge; it completes on its own once required checks pass. Do **not** run open-ended manual polling/wait loops after arming, but do perform a **bounded final-state verification** (`state=MERGED` and non-null `mergeCommit`) and resolve any blocking review threads before idling.
- **Required checks (branch protection):** only `ci` (the aggregate) and `commit-lint`. Everything else (`Build` shows "skipping", `PR Ready/Reviewer Guard`, coverage, security advisory) is **non-required** and never blocks merge.
- **`required_conversation_resolution: true`** — an unresolved review thread blocks auto-merge **even when CI is green**. Always reply to and resolve every review thread.
- **No required human review.** `reviewDecision` is empty by design. Auto-approve automation satisfies any nominal 1-review rule.
- **Strict / up-to-date is on.** A `rebase-prs` bot auto-rebases branches that fall behind `main`; you rarely need to rebase by hand. Expect transient `BLOCKED` right after arming auto-merge while it rebases + re-runs CI.
- **Squash-merge auto-deletes the branch.** For a stacked PR whose head ref must survive, restore the ref afterward (see playbook).

## Per-PR shepherd loop (Mode B)

1. **Acquire the shared lease:** dispatch `ci-recovery.yml` with `operation=lease-acquire`, a generated non-secret lease ID, and the PR number. Verify the sticky state comment shows your lease before touching the branch.
2. **Read state:** `gh pr view <n> --json state,mergeStateStatus,mergeable,reviewDecision,headRefName,isDraft` + `gh pr checks <n>`.
3. **Preflight locally** (persona: **Producer**, declare a 🍎 apple estimate first): `bash scripts/agent/preflight.sh`, then `npm run verify:fast`.
4. **Diagnose every failing/cancelled check before concluding anything.** `gh pr checks <n>` mislabels `CANCELLED` as `fail`. Confirm with `gh run list --branch <branch>` → `gh run view <run-id> --log-failed`. Distinguish a real failure from a concurrency/timing artifact (see playbook §Diagnose).
5. **Fix real failures** with a surgical commit on the PR branch. Add/repair unit coverage in touched areas. Re-run `npm run verify:fast` and `bash scripts/agent/lab-gate-check.sh`. Heartbeat the lease after each meaningful activity and at least every 20 minutes.
6. **Resolve review threads:** read inline comments, address actionable ones in code, then reply to + resolve each thread (conversation-resolution gate).
7. **Release the lease, then arm auto-merge:** only after blockers are clear, dispatch `operation=lease-release`, verify release, then run `gh pr merge <n> --auto --squash`. If `BLOCKED`, diagnose the actual cause — not "review required". If you stop without handing off active work, release the lease; abandoned leases become takeover-eligible after 30 minutes plus queue grace.
8. **Confirm + record:** verify `state=MERGED`, write a handoff in `docs/knowledge/handoffs/`, and (for **≥3🍎** sessions) score apples via `npm run apples:record`. 1–2🍎 sessions do not require an apples JSON. Commit with a conventional message + the `Co-authored-by: Copilot` trailer. Report the final merge commit.

## Scope & worktree rules (Mode A)

- **In scope = open PR with no active CI-recovery/shepherd lease and no active session on its head branch, or with an owner session idle for >30 minutes.** The GitHub-native sticky state/owner label is authoritative for workflow ownership; session metadata remains an additional worktree-safety check.
- **Never `open_pr_session` on a branch already checked out in another live worktree** — it conflicts. Resolve by owner state:
  - Owner **active and recently updated** (<=30m) → delegate via `send_session_message` (pass the actionable review comments + CI run IDs). Do not touch its worktree.
  - Owner **active but idle >30m** → take over: open a PR shepherd session and continue directly.
  - Owner **archived / winding down** → take over: `open_pr_session` for that PR and continue in the child.
  - **No session** → `open_pr_session` and launch a fresh shepherd.
  - Verify with `git -C <main_checkout> worktree list`.

See [`references/playbook.md`](references/playbook.md) for the discovery commands, `open_pr_session` parameters, the `pr_shepherds` SQL tracker, cross-session reporting, and the full diagnosis cookbook.
