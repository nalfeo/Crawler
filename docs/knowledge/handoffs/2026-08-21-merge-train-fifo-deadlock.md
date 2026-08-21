# Merge train FIFO deadlock on un-advanceable head-of-line PR

**Date:** 2026-08-21
**Systems touched:** merge-train, ci-recovery

## Symptom

The merge train ran every ~30 minutes, reported `success` on every run, and
merged nothing for hours. Three PRs carried the `merge-train` label; two of them
(#3216, #3218) were fully green, mergeable, and had zero unresolved review
threads. Nothing moved.

The entire reconcile step produced only two lines of signal:

```
update-branch pr=#3208 same-repo-restricted-branch (403): leaving queued, dispatching recovery
No admitted PR is ready for candidate construction
```

## Root cause

`reconcile.mjs` walks the queued PRs in FIFO order. When an entry is `behind`,
it calls the update-branch API and then unconditionally `break`s out of the
admission loop, so newer PRs cannot leapfrog a PR the train is advancing.

The `break` was skipped only for the **fork-dequeue** case (`dequeuedFork`),
where the entry is removed from the queue entirely.

The **same-repo restricted-branch 403** path (added to fix the #3027 label-churn
livelock) correctly leaves the PR queued — but then fell through to the same
unconditional `break`. That combination is a permanent deadlock:

- the train can never advance the head-of-line PR (403 on every pass), and
- the head-of-line PR is never dequeued (by design, to avoid label churn), so
- the `break` fires on every pass, and every later queued PR starves forever.

`#3208` was the head entry. Its branch is `nalfeo-repair-asset-queue`, which the
merge-train app token cannot push to, so update-branch 403'd on every cycle.
`#3216` and `#3218` were behind it in FIFO order and never got evaluated at all.

The workflow exits 0 on this path, so run status showed `success` throughout and
the deadlock was invisible in the Actions UI.

## Fix

Renamed `dequeuedFork` to `yieldFifoLine` and set it in the same-repo 403 branch
as well. The gate is now `if (!yieldFifoLine) break;`.

The invariant is: **FIFO holds the line for a PR the train is actively
advancing, never for one the train provably cannot advance on any pass.** Both
un-advanceable outcomes (fork dequeue, same-repo restricted branch) release the
line so later entries are still evaluated in the same cycle.

The same-repo PR still stays queued and still dispatches recovery — the #3027
label-churn fix is preserved untouched.

## Regression coverage

Source-assertion and behavioral tests in `reconcile.test.mjs`:

- the same-repo 403 branch must set `yieldFifoLine`
- the FIFO break must be gated on `yieldFifoLine`, and `dequeuedFork` must be
  gone entirely (so the fork-only gate cannot be reintroduced)
- the same-repo 403 branch dequeues **only** inside the quarantine branch, and
  any dequeue there must be paired with the sticky `merge-train-blocked` label
- `evaluateStalledQueue` / `evaluateUnadvanceableStrike` behavior, including
  threshold and strike-reset semantics
- the zero-admitted exit path must evaluate the stalled-queue safeguard before
  `process.exit(0)`

`node --test` across all merge-train test files → 280 pass, 0 fail.
`ci-recovery` suite → 734 pass, 0 fail.

## Safeguards added in the same change

The fix above unblocks this specific deadlock. Three further changes make the
class of failure preventable, self-recovering, and bounded.

### 1. Prevention — documentation

The reason this took three sessions to diagnose is that the agent instructions
were actively wrong: they told agents to run `gh pr merge --auto --squash` and
called auto-merge a "safe fallback". In this repo **auto-merge can never land a
PR** — `merge-train` is itself a required status check (ruleset "Merge Train
Required Checks"), written only by the train's own promotion loop, and
`reconcile.mjs` calls `disableAutoMerge()` on admission. Agents therefore kept
"fixing" stalled PRs by arming auto-merge, which the train silently undid, while
the real blocker (a stuck head-of-queue entry) went unexamined.

Corrected in `AGENTS.md` (Merge Policy), `.github/agents/pr-shepherd.agent.md`
(Crawler merge facts), and `.github/skills/pr-shepherd/SKILL.md`. All three now
carry the same four facts: the train is the only merge path; how the train
actually lands a PR (label → FIFO admission → candidate → validation →
promotion); `BLOCKED` on a green PR means "waiting for the train", not "needs a
human"; and a green Merge Train run is **not** evidence that anything merged.

### 2. Auto-recovery — stalled non-empty queue detection

The existing liveness detector only fires when `queued.length === 0`. This
deadlock was the exact inverse: a **full** queue admitting nothing. Nothing
alarmed, because reconcile exits `0` on that path.

`evaluateStalledQueue` now classifies "queue non-empty **and** zero admitted" as
a stall, and after `STALLED_QUEUE_PASS_THRESHOLD` (3) consecutive reconcile
passes escalates a managed `ci-incident` issue naming the head-of-queue PR as
the likely blocker. The issue auto-closes as soon as the train admits a
candidate again, or when the queue drains to empty.

**The counter must be persisted from the first stalled pass, not at the alarm.**
The first draft stored the consecutive-pass counter in the incident body but
only created that issue once `alarm` was true — and `alarm` requires
`passes >= 3`. The counter could therefore never read back above `0`, pinned at
`1` forever, and the alarm was structurally unreachable: the entire safeguard
was dead code. Both the plan review and the code review caught this
independently. Below the threshold the issue is now a quiet **unlabeled**
tracking record; the `ci-incident` label is applied only at the alarm, so
persistence never depends on the condition it is trying to detect. A regression
test asserts the write is gated on `stall.stalled`, never on `stall.alarm`.

### 3. Eject + quarantine — bounded blast radius

A PR the train can never advance must not sit at the head of the queue forever.
`evaluateUnadvanceableStrike` counts consecutive update-branch 403s **on the same
head SHA**; after `UNADVANCEABLE_STRIKE_THRESHOLD` (3) strikes the PR is removed
from the queue and quarantined with `merge-train-blocked`, with a status comment
explaining the ejection and how to re-queue (rebase out-of-band, remove the
label).

Four details matter here:

- **Quarantine must be sticky**, or this reintroduces the #3027 label-churn
  livelock. `merge-train-blocked` is already in `router.mjs`'s
  `DISPATCH_BLOCKED_LABEL_NAMES`, so CI Recovery will not re-queue a quarantined
  PR into the same 403 loop. The regression test asserts that any dequeue on
  this path is paired with that label.
- **Strikes reset on a new head SHA**, so the intended recovery (an out-of-band
  rebase) clears the record rather than being penalized for earlier failures.
- **A cumulative attempt ceiling backstops that reset.** Resetting on head
  movement alone lets a bot pushing ineffective commits reset the counter every
  pass and evade quarantine indefinitely while still failing every update.
  `UNADVANCEABLE_ATTEMPT_CEILING` (10) never resets, so persistent
  un-advanceability is always eventually quarantined. Legacy two-field markers
  still parse, crediting existing strikes as attempts.
- **Recovery dispatch must not run on the quarantine branch.** Dispatching
  before the strike evaluation raced quarantine: the recovery run could
  converge, strip `merge-train-blocked`, and re-admit the PR into the same 403
  loop. `router.mjs` exclusion only blocks _new_ dispatch selection — it cannot
  cancel an in-flight one. Dispatch now happens only on the still-queued branch.

### FIFO release covers every non-advancing path

The initial fix set `yieldFifoLine` only on the same-repo-403 path. Review
pointed out that the `422` and unexpected-status branches also leave the PR
queued without advancing it, so either could reproduce the original deadlock
through a non-403 route (e.g. a stale `behind` result paired with repeated
"already up-to-date" 422s). Both now release the line too. The invariant is:
**FIFO holds the line only for a PR the train is actively advancing, never for
one it did not advance on this pass.**

## Follow-up (not done here)

Agent-authored PRs still open with auto-merge unarmed (`autoMergeRequest: null`
on 7/7 open PRs, observed three days running). Given the finding above this is
**not** a leak to fix — unarmed is the correct steady state in this repo, and
the earlier framing of it as a bug was itself the mistake. Left recorded here so
a future session does not "fix" it again.
