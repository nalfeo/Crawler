# Goobers human-escalation and resume protocol

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **2**
- Hard gate: the escalation, human-decision, and resume paths are documented with exact examples and markers; CI Recovery remains unchanged.

## Purpose

Use this protocol when a trusted review validator confirms a finding but cannot
make the required change within its repair scope. The goal is to stop repeated
automation on a non-converging task while keeping the PR available for an owner
to finish or intentionally abandon.

This is a **PR review-thread** protocol. It is not a request to modify the
Goobers issue labels, disable CI, or manually rerun recovery. CI Recovery
recognizes the declaration and performs the quarantine transition.

## Agent: declare the escalation in the review thread

Reply in the affected review thread only after the validator has established
that the finding is valid and outside its repair scope. The reply must state
both:

1. that the finding is being escalated to a human, maintainer, or owner; and
2. that the thread is deliberately being left unresolved.

A concise valid example is:

> This finding is valid but outside my repair scope. I am escalating it to a
> human and leaving this thread unresolved.

An external-action variant is also valid:

> The required repository change needs a maintainer with the necessary
> permissions, so I am leaving this thread unresolved for human escalation.

Do not use a conditional or hypothetical statement. These do **not** declare
an escalation:

> Escalate to a human if this happens again.

> Leaving this thread unresolved until the rebase lands.

Do not quote an earlier escalation as if it were your own declaration. Put the
declaration in the author's unquoted reply. The recovery parser requires the
human hand-off and unresolved language in the same non-conditional clause.

After posting the declaration, do not resolve the thread and do not post a
second automated repair task for the same finding. The existing CI Recovery
reconciliation will quarantine the PR once every remaining blocker is an
escalated review thread. Other blockers, such as failing checks or repairable
review threads, remain actionable and prevent this human-only quarantine.

## Human: inspect the quarantine and choose an outcome

When CI Recovery receives the declaration, it moves the PR to the
`ci-lifecycle-quarantined` lifecycle label. The PR is excluded from
train-blocking positions and automated repair dispatches, but it is not
automatically closed. A managed quarantine comment identifies the escalated
evidence and gives the same two choices below.

### Keep and resume

The PR owner should:

1. Read each escalated thread and make the requested change in an owner
   session.
2. Reply to each addressed thread using the trusted marker format:

   `✅ Addressed in <sha>: <one-line note>`

   Use the commit SHA that contains the fix. If the concern is deterministically
   not applicable and no code change is needed, use:

   `✅ Not applicable: <one-line reason>`

3. Confirm that all escalated threads are addressed or marked not applicable.
4. Post the exact standalone comment `KEEP` on the PR as the owner.

`KEEP` is intentionally exact: no quote marks, backticks, explanation, or
additional text. The owner command is accepted only after the escalation, so a
stale `KEEP` from before the quarantine cannot resume the PR. A valid `KEEP`
removes the quarantine state and re-enters the normal lifecycle as
`repairing`; automated recovery can then continue from the updated review and
CI state.

### Abandon and restart

If the PR should not be continued, the PR owner posts the exact standalone
comment `ABANDON`. CI Recovery closes the PR and moves it to the terminal
`ci-lifecycle-abandoned` state. The linked issue can then be restarted through
the normal intake path with a fresh implementation when appropriate.

`ABANDON` is also case-sensitive and must not be embedded in a sentence. Do
not use it merely to ask for advice.

## Resume checklist

Before expecting automated recovery to resume, verify:

- every remaining escalated review thread has a trusted `✅ Addressed in <sha>:
...` or `✅ Not applicable: ...` reply;
- the owner posted `KEEP` as a standalone PR comment after the escalation;
- no unrelated failed check, merge conflict, or unresolved repairable thread is
  still blocking the PR; and
- the PR head contains the intended fix and is not a stale or superseded
  commit.

No workflow dispatch, label editing, or manual state-comment repair is needed
for the normal path. If the owner command was rejected, inspect the latest
managed quarantine comment and the PR's lifecycle labels rather than posting
variants of `KEEP` or `ABANDON`.

## Scope and ownership boundary

This guide documents the existing CI Recovery contract; it does not change the
parser, review-thread resolver, lifecycle state machine, or merge train.
CI Recovery remains the writer for lifecycle labels and managed state. Review
agents own only their review-thread replies, and the PR owner owns the final
`KEEP` or `ABANDON` decision.

## Verification

- `bash scripts/agent/preflight.sh`
- `git diff --check`
- `npm run docs:check`
- `bash scripts/agent/verify-fast.sh`

## Risk

The change is documentation-only, so runtime behavior and CI mutation paths are
unchanged. The residual risk is operator miswording or use of non-exact
commands; the guide mirrors the parser's conjunction rules, trusted review
markers, lifecycle labels, and exact owner-command behavior to make those
failure modes explicit.
