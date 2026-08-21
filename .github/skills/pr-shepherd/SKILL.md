---
name: pr-shepherd
description: >-
  Drive open GitHub pull requests to a clean squash-merge in the Crawler repo.
  Use when asked to "shepherd" a PR, run a "PR shepherding loop", drive/babysit
  PRs to merge, clear the open-PR queue, or unblock a stuck PR through CI and
  review. Covers discovering in-scope PRs (open, no active session, or owner
  idle >30m), launching one child session per PR in parallel, diagnosing and
  fixing REAL CI failures, resolving review threads, and handing admissible PRs
  to the merge train per the repo merge policy.
---

# PR Shepherd

Take one or more open PRs from "open" to "squash-merged into `main`" without hand-holding: discover what is in scope, fix the real blockers (CI failures, unresolved review threads), and let the **merge train** finish the job. **The merge train is the only thing that can merge a PR here** — `merge-train` is a required check that only the train writes, so never arm auto-merge and never blame a "review block" (no human review is required in this repo).

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

- **The merge train merges, not you. Do not arm auto-merge.** `merge-train` is a required status check that only the train's promotion loop ever writes, so `gh pr merge --auto --squash` can never land a PR here — and `reconcile.mjs` calls `disableAutoMerge()` on admission, actively undoing it. Your job is to make the PR _admissible_ (green `ci`, resolved threads, not `BEHIND`/`DIRTY`), then let the train land it. Do **not** run open-ended polling loops; do a **bounded final-state verification** (`state=MERGED` and non-null `mergeCommit`).
- **How the train lands a PR:** the `merge-train` label is the queue; reconcile runs ~every 30 min; queued PRs are admitted **FIFO** (oldest first); a `behind` head entry is fast-forwarded via update-branch and **holds the FIFO line** while it advances; admitted PRs are batched into a candidate that must pass `Merge Train Validation`; only then does App-bypass promotion write `merge-train` and squash-merge.
- **A green Merge Train run does not mean anything merged.** Reconcile exits `0` on every stall path. `No admitted PR is ready for candidate construction` alongside a non-empty queue means the head of the queue is stuck and everything behind it is starved — inspect the **oldest** queued PR, not the one you were asked about.
- **Required checks (GitHub Ruleset 19000576, "Merge Train Required Checks"):** `ci` (the aggregate) **and** `merge-train` for every ordinary actor. Classic branch protection's `required_status_checks` is disabled (only that setting — `required_conversation_resolution` and every other classic setting remain active). The trusted repository App has `bypass_mode: always` on the ruleset and performs all Merge Train promotions directly (sequentially squash-merging each queued PR via API bypass). The `merge-train` check is **written by trusted reconciliation on the PR head immediately before that App-bypass promotion** — it is not a polling target for `gh pr checks` and nothing posts it for ordinary non-App merges. What the batch validation step publishes is `merge-train-candidate` on the current `main` SHA (not on individual PR heads). A PR can show green `ci` and stay `BLOCKED`/`BEHIND` while waiting for the Merge Train to pick it up; once it does, the App writes `merge-train` and promotes atomically. Everything else (`Build` shows "skipping", `PR Ready/Reviewer Guard`, coverage, security advisory) is **non-required** and never blocks merge.
- **`required_conversation_resolution: true`** — an unresolved review thread blocks train promotion **even when CI is green**. Always reply to and resolve every review thread.
- **No required human review.** `reviewDecision` is empty by design. Auto-approve automation satisfies any nominal 1-review rule.
- **Merge Train disarms auto-merge:** The Merge Train's `reconcile` job (`.github/workflows/merge-train.yml`) **actively disarms any manually-armed `gh pr merge --auto`** each time it processes a PR in its queue. A disarmed PR is normal and expected — do **not** re-arm it; re-arming mid-flight interferes with promotion.
- **Branch updates:** The `auto-rebase-prs.yml` workflow ("Auto-rebase open PRs") handles rebases. When the Merge Train is enabled it only dispatches targeted conflict-recovery rebases, not a blanket sweep. The Merge Train's own `reconcile` job also updates branches as part of its batch-validation cycle. As a manual fallback, `gh api -X PUT repos/nalfeo/Crawler/pulls/<n>/update-branch` reliably pulls latest `main` into a behind branch.
- **Squash-merge auto-deletes the branch.** For a stacked PR whose head ref must survive, restore the ref afterward (see playbook).

## Per-PR shepherd loop (Mode B)

1. **Acquire the shared lease:** dispatch `ci-recovery.yml` with `operation=lease-acquire`, a generated non-secret lease ID, and the PR number. Verify the sticky state comment shows your lease before touching the branch.
2. **Read state:** `gh pr view <n> --json state,mergeStateStatus,mergeable,reviewDecision,headRefName,isDraft` + `gh pr checks <n>`.
3. **Preflight locally** (persona: **Producer**, declare a 🍎 apple estimate first): `bash scripts/agent/preflight.sh`, then `npm run verify:fast`.
4. **Diagnose every failing/cancelled check before concluding anything.** `gh pr checks <n>` mislabels `CANCELLED` as `fail`. Confirm with `gh run list --branch <branch>` → `gh run view <run-id> --log-failed`. Distinguish a real failure from a concurrency/timing artifact (see playbook §Diagnose).
5. **Fix real failures** with a surgical commit on the PR branch. Add/repair unit coverage in touched areas. Re-run `npm run verify:fast` and `bash scripts/agent/lab-gate-check.sh`. Heartbeat the lease after each meaningful activity and at least every 20 minutes.
6. **Resolve review threads:** read inline comments, address actionable ones in code, then reply to + resolve each thread (conversation-resolution gate).
7. **Release the lease, then hand off to the train:** only after blockers are clear, dispatch `operation=lease-release` and verify release. Ensure the PR carries the `merge-train` label and is not `BEHIND`/`DIRTY`; the train does the merging. Do **not** run `gh pr merge --auto`. If `mergeStateStatus` is `BLOCKED` with green `ci`, that is the normal "waiting for the train" state — diagnose the train (oldest queued PR, reconcile logs), not the PR. If you stop without handing off active work, release the lease; abandoned leases become takeover-eligible after 30 minutes plus queue grace.
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
