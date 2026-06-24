# Comment Resolution Policy

## Purpose

Review threads (PR review comments, bot findings, human nits) must be closed
**reliably and auditably**. This policy defines the single contract every agent
and automation follows so that no comment is ever silently dropped and every
resolved thread carries a documented reason.

GitHub has no concept of "closing" a single review comment — you **resolve the
review thread** the comment belongs to. Resolution is only available through the
GraphQL `resolveReviewThread` mutation (there is no REST equivalent), and a
thread can contain many comments. This policy operates on **threads**, not
individual comments.

## The Contract

> **Never resolve a review thread without first replying to it.**

Every resolution must be preceded by a reply on that same thread containing one
of the machine-readable **disposition tokens** below. The reply is what makes a
closure auditable, reviewable, and reversible.

| Disposition                         | Required reply token (must be in the reply body) | When to use                                                                                  |
| ----------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **Addressed** (fixed)               | `Addressed in <sha>`                             | The comment was acted on. Cite the commit SHA that fixes it.                                 |
| **Declined** (incorrect/irrelevant) | `Resolving: <reason>`                            | The comment is a false positive, out of scope, or otherwise will not be actioned. State why. |

Examples of a valid declined reply:

- `Resolving: false positive — value is validated upstream at world.ts:42.`
- `Resolving: out of scope — tracked separately in #123, not this PR.`
- `Resolving: irrelevant — comment targets generated code we do not hand-edit.`

A `Resolving:` reply **must include a reason** after the colon. An empty reason
is treated as no token and the thread stays open.

## Rules

1. **Reply, then resolve.** Post the disposition reply to the thread first, then
   resolve it. Use the `reply_to_comment` tool (or equivalent) for the reply.
2. **Never silently resolve.** Do not resolve a thread without a token reply, and
   never bulk-resolve all open threads. If you cannot honestly produce an
   `Addressed in` or `Resolving:` reply, leave the thread open.
3. **Never unilaterally ignore.** "This doesn't matter" is not a disposition. If
   you decline a comment, the `Resolving: <reason>` reply is mandatory and must
   explain the judgment so a human can audit and reopen it.
4. **Idempotent.** Skip threads already marked resolved. Re-running resolution
   must never error or double-post.
5. **Reversible.** Because every closure has a reason on-thread, a reviewer can
   reopen any thread they disagree with.

## Enforcement (deterministic, not trust)

Per the project's "deterministic CI only" principle, this behavior is enforced by
a script with an exit code rather than by instruction alone.

- **`.github/workflows/resolve-addressed-threads.yml`** is the enforcement
  mechanism. It is the **only** path that should resolve threads. It queries each
  open PR's review threads via GraphQL and resolves a thread **only when its most
  recent comment matches a disposition token** (`Addressed in <sha>` or
  `Resolving: <reason>`). No token on the latest comment ⇒ the thread is left
  open. This structurally makes the reason mandatory: no reply, no resolution.
- The workflow runs on `pull_request_target` (`synchronize`, so it fires when an
  agent pushes a fix), on an hourly `schedule` as a fallback, and via
  `workflow_dispatch`. It needs `pull-requests: write`. Threads are resolved as
  `github-actions[bot]`.

Because resolution always flows through the workflow, agents do **not** call
`resolveReviewThread` directly — they only post the token reply and let the
workflow close the thread on the next run.

## Agent Workflow Summary

1. Read each unresolved review thread.
2. For each thread, either **fix it** and reply `Addressed in <sha>`, or
   **decline it** and reply `Resolving: <reason>`, or **leave it open** if you can
   do neither.
3. Push your changes. The resolve workflow closes every threaded comment that now
   carries a disposition token.

## Related

- `docs/agent-os/policies/ci-policy.md` — deterministic-gate principle.
- `docs/agent-os/personas/reviewer.md` — the Reviewer persona that raises threads.
- `.github/workflows/pr-ready-reviewer-guard.yml` — sibling `github-script` +
  GraphQL guard this workflow is modeled on.
