# 2026-09-04 Goobers run four-slot concurrency

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## What changed

Reworked the 2x2 concurrency design committed in `988a111c6`. That commit ran
one `goobers up` daemon per lane and, when a recovery target existed, ran it
sequentially to completion before opening a second slot — so lane 1 never had
two tasks in flight and the real peak was three, not four. It also left
per-lane post-processing on newest-journal-only selection, which could strand a
sibling slot's issue on `goobers/status:in-review`. Both are fixed here.

- **`goobers-run.yml` — four genuinely concurrent slots.** `strategy.matrix.lane:
[1, 2]` (`max-parallel: 2`) with `GOOBERS_SLOTS: '1 2'` per lane. Each slot
  is its own instance root under `GOOBERS_LANE_ROOT/slot-<n>`, and "Run the
  workflow" launches both slots' blocking `goobers run --github-progress`
  processes at once, then waits on both and aggregates their exit codes. The
  `goobers up` daemon and `goobers run --no-wait` delegation are gone.
- **Exactly one recovery slot.** `GOOBERS_RECOVERY_LANE`/`GOOBERS_RECOVERY_SLOT`
  name it (lane 1, slot 1). Every other slot unsets
  `GOOBERS_RECOVERY_ISSUE`/`RESUME_*` in its own subshell, so 1 recovery + 3
  fresh — or 4 fresh when no recovery target exists.
- **Preflight no longer claims fresh work.** The scheduled sweep's
  fresh-backlog scan now only answers "is there eligible work?" (preserving the
  cheap no-work exit) instead of promoting an issue to `ISSUE_NUMBER`. A
  preflight-selected fresh target is invisible to Goobers' provider claim
  protocol, so a fresh slot would have raced onto the same issue.
- **The recovery target is reserved by a job both lanes need.** A dedicated
  `reserve` job resolves the target, applies `goobers/status:in-review`, and
  confirms the label through the same provider read a fresh claim performs;
  `jobs.run` declares `needs: reserve`, so no lane — and therefore no
  `backlog-query --claim` — exists until that has happened. See "Review finding
  1" below for why an early per-lane step was not equivalent.
- **`crawler-feature-pr.yaml`: `excludeLabel` → `excludeLabels`.** Goobers reads
  the plural key (`cmd/goobers/backlogquery.go`'s
  `providerInput("excludeLabels")`), so the singular spelling had been excluding
  nothing. It was inert while `GOOBERS_RECOVERY_ISSUE` was always set (the
  fresh `backlog-query --claim` path never ran in CI); it becomes load-bearing
  the moment three slots use that path. Now
  `goobers/status:in-review,goobers/status:completed-existing-work`.
- **`readiness.maxConcurrentRuns` and `runConditions.maxParallelRuns` back to 1.** Concurrency comes from four isolated single-capacity roots, so the
  four-workflow ceiling is structural rather than arithmetic.
- **Per-run lifecycle bookkeeping.** "Handle no-work disposition" and "Comment
  on Goobers run result" now enumerate every run journal of every slot and
  process each one. Each run's disposition is driven by its own
  `run.finished` phase rather than the lane-wide `job.status`, so one slot's
  failure cannot strip a healthy sibling's ownership. Result-comment markers
  carry `lane=`/`slot=`/`goobers-run=` so four runs sharing one Actions run id
  do not overwrite each other's comments.
- **Stale provider claim markers are retired.** Every run gets
  `goobers backlog-query --release <slot root>` with its own `GOOBERS_RUN_ID`.
  A run killed before Goobers' in-process terminal cleanup would otherwise
  leave `goobers:claimed` plus its claim breadcrumb behind, and `claimWinner`
  resolves by the earliest surviving breadcrumb — the issue would become
  permanently unclaimable, and this repo runs no backlog-curation
  reconciliation pass to repair it. The release reads the slot's on-disk claim
  ledger, so it works after the process is gone, and short-circuits with no
  network call when the run holds nothing. Failure after three attempts is an
  `::error::` naming the manual remediation, not a swallowed warning.
- **Bounded completion.** The slot deadline is derived from the job's absolute
  budget rather than from the start of "Run the workflow" — see "Review finding
  4" below, and round four's finding 2 for how the reserve became an enforced
  ceiling. `GOOBERS_SLOT_DEADLINE_SECONDS: '3300'` (55 min) caps it and
  `GOOBERS_CLEANUP_RESERVE_SECONDS: '2100'` is carved out of the 90-minute
  ceiling. The deadline tears down each slot's whole stage process tree and
  requires a verified terminal journal phase before anything is released — see
  "Review finding 2" below.
- Journal artifact paths cover every slot
  (`$GOOBERS_LANE_ROOT/slot-*/gaggles/*/runs/`) plus an unconditionally written
  `slot-*/diagnostics/` sentinel, preserving the `slot-<n>/` prefix so each run
  is attributable and guaranteeing the artifact exists even when a slot produced
  no journal. A second `goobers-run-repaired-*` artifact captures the same trees
  after `goobers run abort` repairs any non-terminal journal.

## Review findings and resolutions

Two high-severity findings from independent review of this branch, three
follow-up bugs found by a second review of the fixes themselves, four more
findings (2 high, 2 medium) from a third independent review, and six more
(2 high, 4 medium) from a fourth. All fifteen are fixed here; none is
outstanding.

### Review finding 1 (high) — matrix legs had no reservation ordering

**Finding.** The two `strategy.matrix.lane` legs both resolved the recovery
target and lane 2 exited before lane 1 applied `goobers/status:in-review`. Legs
start simultaneously, so lane 2's fresh slots could run
`goobers backlog-query --claim` and atomically take the very issue lane 1 was
about to resume. The recovery path bypasses the provider claim protocol
(`crawler-feature-pr.yaml`'s query-backlog recovery branch just labels the
issue), so nothing else settles that collision — two agents, one issue.

**Why "both legs reserve early" would not have fixed it.** Both legs are still
concurrent, so an early per-lane reservation only narrows the window; and the
claim scan reads through GitHub's REST issues list, which the label write has to
become visible in before the exclusion means anything. Ordering had to be
structural.

**Resolution.**

- A dedicated `reserve` job now owns resolution, the `abandon_existing`
  mutation, the `goobers/status:in-review` write and the start comment, and
  publishes `should_run` / `recovery_issue` / `resume_pr` / `resume_branch` as
  job outputs. `jobs.run` declares `needs: reserve`, so neither lane exists
  until the reservation has landed. That `needs:` edge is the ordering proof.
- The reservation is not merely written but **confirmed**: `reservation_visible`
  replays the exact provider query a fresh claim performs — the REST issues list
  filtered by the trust label, exclusions applied to each returned issue's own
  label array (`providers/github.go`'s `ListWorkItems` plus
  `cmd/goobers/backlogquery.go`'s `scanBacklogEligibility`) — rather than the
  eventually consistent search index. Ten bounded attempts, then the job fails
  closed with the remediation command. One lost dispatch beats duplicated agent
  work.
- Only `GOOBERS_RECOVERY_LANE` adopts the outputs, in the new "Adopt the
  reserved recovery target" step, so lane 1 slot 1 keeps sole ownership of
  recovery metadata _and_ of the disposition/cleanup for it. Lane 2 never sets
  `GOOBERS_RECOVERY_ISSUE`, which also stops it synthesizing a disposition
  record for an issue it does not own.
- The whole-job gate replaced the twelve per-step `should_run` gates, so an
  empty backlog sweep now skips both lane runners outright instead of starting
  them to skip fourteen steps.
- Splitting the reservation out opened two new ways to strand the label —
  `reserve` succeeds and the workflow is cancelled while `run` is queued, or the
  recovery lane fails _before_ "Adopt the reserved recovery target" (checkout,
  source preservation, job timeout, lost runner), so its `always()` disposition
  never learns the issue number. The new `release-unstarted-reservation` job
  (`needs: [reserve, run]`, fires on every non-success `run` result) closes both
  by applying the same rule that step would have: preserve
  `goobers/status:in-review` while an open Goobers PR holds resumable work,
  release it otherwise, and never release on an unreadable timeline or PR. A
  successful `run` is excluded — its lane owns the disposition.

**Executable regression** (`goobers-run-slot-cleanup.test.ts`, "recovery
reservation ordering"): the real reservation script and the real slot-launch
script run against one shared fake provider in both interleavings. Ordered (what
`needs:` guarantees) → both of lane 2's fresh slots SKIP the issue. Unordered
(the pre-fix shape) → both CLAIM it. The negative control is what makes the
positive case meaningful rather than a stub that simply cannot claim.

### Review finding 2 (high) — the deadline killed the CLI, not the run

**Finding.** The deadline handler signalled only each `goobers run` pid. Stage
children survive that, so cleanup could release provider claims and issue labels
while Copilot and verification children were still running.

**Verified against the pinned `goobers-dev-6d33b160` source**, because the fix
depends on which of several plausible stories is actually true:

- Every stage is detached into its **own session**, not merely its own process
  group: `internal/platform/proc/proc_unix.go`'s `configure` sets
  `SysProcAttr.Setsid` (`internal/executor/shell.go` and
  `internal/harness/process.go` both spawn through it). A session leader's pgid
  equals its own pid, so neither `kill <pid>` nor `kill -<pgid>` reaches a
  stage.
- SIGTERM does not cancel the stage already running. The runner dispatches each
  attempt on `context.WithoutCancel(ctx)` and only checks cancellation _between_
  stages (`internal/runner/run.go`), so a signalled `goobers run` keeps its
  in-flight children and merely declines to start the next stage. A second
  signal is worse, not better: `run`'s `signals.SetupSignalContext` hard-exits
  the process (`internal/signals/signals.go`), orphaning everything.
- The pinned build has **no daemon-free cancellation command**. `goobers run
cancel` writes a request into `scheduler/pending-cancels` and only
  `cmd/goobers/up.go` sweeps that directory (`cmd/goobers/runcancel.go`); this
  workflow deliberately runs bare `goobers run` instances, not a daemon, so
  `run cancel` would answer `not_running`. `goobers run abort` is the sanctioned
  daemon-down path but it is journal repair — it signals nothing.

**Resolution.** `scripts/agent/goobers-stage-teardown.sh` owns the teardown at
the Actions wrapper, modelled on Goobers' own `Tree.kill` (snapshot descendants
from `/proc` _before_ signalling; signal each one guarded by its start time so a
recycled pid can never be hit) and extended with the session axis `Setsid`
makes necessary. Selection is exact and never a process-name match:

1. the `/proc` ppid closure rooted at the slot's `goobers run` pid;
2. every process whose session id belongs to a process already in the closure
   and is not this script's own session — a session id only ever comes from a
   `setsid(2)` call, so a stage's session holds that stage's descendants and
   nothing else, including ones reparented to init when their stage died;
3. every process whose environment carries `GOOBERS_INSTANCE=<slot root>` — the
   per-slot identity the workflow exports and lists in `runner.envPassthrough`,
   so every stage descendant inherits it. This is what still finds the tree
   after the root process has exited.

The script's own pid and every one of its ancestors are excluded, so it can
never signal the runner or the step's shell. It SIGTERMs, waits the grace
period, re-snapshots (catching anything spawned meanwhile), SIGKILLs, and then
**verifies**: it exits non-zero with an actionable `::error::` if anything
survives.

That refusal is load-bearing rather than advisory. The `always()`
"Reap surviving Goobers stage processes" step (`id: reap-stage-processes`) is
the single authoritative gate, and "Handle no-work disposition" runs only on
`steps.reap-stage-processes.outcome == 'success'`. Every mutation in that step
either retires a provider claim or removes `goobers/status:in-review`, and doing
either while a stage is still pushing commits hands the issue to a second agent
while the first keeps working — so a surviving tree stops the release, and the
reap step's `::error::` names the manual reconciliation. The deadline path
funnels through the same gate: anything it failed to kill is still alive when
the reap runs.

The sweep is also fail-closed about its own input. The /proc snapshot is built
with awk `getline` driven by the `/proc` listing, **not** by handing the
`/proc/[0-9]*/stat` glob to awk as argv: a pid that exits between the glob and
the open makes both gawk and mawk fatally exit, silently truncating the snapshot
at that point. A truncated snapshot is the worst failure available here — it can
report a live tree as terminated, and if it drops this script's own entry the
session/ancestor exclusions that keep the sweep off the Actions runner stop
working. `getline` returns -1 for an unreadable file instead, so a process that
exited mid-sweep is simply absent, which is correct. On top of that, an empty
snapshot or one with no entry for the sweeping shell aborts the teardown with a
non-zero status rather than producing a member list that merely looks empty.

It is wired in twice: the deadline path in "Run the workflow", and the
`always()` reap step that covers a cancelled or failed job (where the deadline
never fires). The reap sits after the host profile — so the profiled window
stays exactly the run — and before the journal upload and every claim/label
mutation.

Finally, `force_terminal_journal` runs `goobers run abort <run-id> <slot root>`
for any run whose journal has no `run.finished`, and re-reads the journal, all
_before_ `release_claim_marker`. The claim ledger and the journal therefore
always agree by the time the step reports, instead of a claim being retired
while the journal still says the run is live.

**Executable regression** (`goobers-run-slot-cleanup.test.ts`, "slot deadline
teardown"): a `goobers` stub reproduces the real process model — a
session-detached (`setsid`) grandchild that outlives its parent and heartbeats
to a file — and the test drives the real "Run the workflow" script to its
deadline, then asserts the step reported `stage tree fully terminated`, the
grandchild pid is dead, the heartbeat has stopped, **and** an unrelated process
started outside the slot tree is untouched. A "fail-closed behaviour" suite
asserts the sweep refuses to run on a snapshot missing its own entry, and that
the snapshot really contains both the sweeping shell and a process created after
it (the truncation regression). A further test asserts the abort-before-release
ordering by run id.

### Second review round

A follow-up independent review of the fixes above found three further bugs, all
fixed here:

1. **Snapshot truncation (critical).** `goobers_teardown_snapshot` handed the
   `/proc/[0-9]*/stat` glob to awk as argv; a pid exiting in that window makes
   awk fatally exit, silently dropping every later entry. Rewritten around
   `getline`, plus the fail-closed empty/no-self checks described above.
2. **The teardown's refusal was advisory.** Nothing consumed the reap step's
   exit status, so a detected survivor still let "Handle no-work disposition"
   release the claim and the label. The reap now has an `id` and that step is
   gated on its outcome.
3. **`release-unstarted-reservation` missed `needs.run.result == 'failure'`**,
   which strands the reservation when the recovery lane fails before adopting
   it. Added, with a test pinning all three non-success results.

Each has a matching assertion in `goobers-run-workflow.test.ts` or
`goobers-run-slot-cleanup.test.ts`, so none can silently regress.

### Third review round

A third independent review of the branch found four more issues. All four are
fixed here, each with an executable regression.

#### Finding 1 (high) — reservation ownership could be lost while a recovery stage was still live

**Finding.** `release-unstarted-reservation` fired on `needs.run.result` alone,
and that result is the **aggregate** of two matrix legs. It reads `failure` in
three materially different situations: the recovery lane never adopted the
reservation; the recovery lane adopted it, its reap failed, and a descendant may
still be pushing; and a healthy recovery lane whose _sibling_ lane failed. In the
last two the guard removed `goobers/status:in-review` out from under a live
owner. Separately, `concurrency: goobers-run-reserve` only holds for the length
of the reserve job while its lanes run for up to 90 more minutes, so a second
dispatch could designate the very issue this dispatch's recovery slot was
resuming — and the recovery path bypasses Goobers' provider claim protocol, so
nothing else settles that.

**Resolution — owner-bound evidence held through cleanup.**

- "Adopt the reserved recovery target" posts an **adoption receipt** comment on
  the reserved issue _before_ it exports any recovery metadata. A lane that
  cannot write the receipt fails before starting a slot, so the receipt's
  absence is deterministic proof that no lane ever adopted the reservation.
- A new `Record reservation disposal` step appends a **disposal receipt** to that
  same comment, and only when `steps.reap-stage-processes.outcome` _and_
  `steps.handle-disposition.outcome` are both `success`. Anything else leaves the
  receipt adopted-but-undisposed and fails the step with the manual
  reconciliation command.
- `release-unstarted-reservation` now reads the receipt instead of inferring
  ownership from a job result: no receipt → release (subject to the existing
  open-PR check); adopted **and** disposed → the lane's own label state is
  authoritative, do nothing; adopted without disposed → refuse, with an
  `::error::` naming the reconciliation. An unreadable comment list fails closed
  and preserves the label.
- Both markers are registered in `.github/scripts/ci-recovery/markers.mjs`, and
  the adoption marker is the comment's leading line so `ci-recovery-router`'s
  `startsWith` filter suppresses it rather than routing this automation's own
  comment back in.

**Resolution — cross-dispatch recovery single-flight.** A new
`Detect a live sibling dispatch` step (`id: singleflight`) asks the Actions API
whether any other run of `goobers-run.yml` is not `completed`, excluding this
run. While one is live this dispatch designates **no** recovery target: an
issue-labeled event defers with a notice and continues with fresh claims (which
are claim-protected and therefore safe), and an explicit `issue_number` fails
loudly rather than being silently downgraded. An unreadable run list fails closed
on the safe side. This deliberately does **not** serialize the two lanes within a
dispatch; the static per-lane concurrency groups already queue lane _n_ of a
later dispatch behind lane _n_ of this one, which is what holds the four-slot
ceiling globally. `permissions: actions: read` was added for the API read.

**Executable regressions** (`goobers-run-slot-cleanup.test.ts`): "reservation
ownership evidence" drives the real guard script against three comment fixtures
(no receipt → releases; adopted-only → refuses and mutates nothing;
adopted+disposed → leaves it alone), and the real disposal step against a clean
reap/disposition and against both failure shapes. "cross-dispatch recovery
single-flight" runs the real detection step with the workflow's **own** `--jq`
filter applied to a realistic `/actions/runs` payload (proving the self-exclusion
and status filter), then drives the real resolution step through the deferral,
the explicit-request failure, and a negative control that shows the guard is
load-bearing.

#### Finding 2 (high) — a failed terminal repair still permitted cleanup

**Finding.** `force_terminal_journal` returned 0 when the `goobers` binary was
missing and when `goobers run abort` failed, so a run whose journal still
reported it live could have its provider claim retired and its
`goobers/status:in-review` removed. A failed claim release only set a status
variable that was returned _after_ the label mutations had already run, so it
did not bar them. And the retained journal artifact was uploaded _before_ the
repair, so the repaired journal was never captured.

**Resolution.**

- Two explicit barriers in `process_run`, both evaluated before any mutation:
  `terminal_verified` (a journal-bearing run with no `run.finished` after the
  repair stops everything for that run) and a hard `if ! release_claim_marker …`
  (a claim that could not be retired bars every label change, because an issue
  whose status label is removed while its claim survives is _permanently_
  unclaimable — `claimWinner` resolves by the earliest surviving breadcrumb).
  Both report `::error::` with the exact reconciliation commands. The barriers
  are per run, so a healthy sibling slot's bookkeeping still completes.
- `force_terminal_journal` and `release_claim_marker` now return non-zero on the
  no-binary path instead of warning and continuing. The authority for
  "terminal?" remains the journal re-read, not the abort's exit status — a
  repair that reports success while the journal stays non-terminal is caught.
- A second `Upload repaired run journal` artifact
  (`goobers-run-repaired-…`, `if: always()`) captures the post-repair journals.
  Keeping both uploads means the pre-repair state survives a skipped disposition
  (failed reap) and the post-repair state survives a failed one.

**Executable regressions**: "terminal-journal barrier" drives the real
disposition step with four `goobers` stubs — repair succeeds (control: releases
and relabels), `run abort` errors, `run abort` reports success but repairs
nothing, and `backlog-query --release` fails — and asserts in each failure case
that no claim was released, no `gh issue edit` ran, and the healthy sibling run
was still processed.

#### Finding 3 (medium) — an expected empty slot failed the lane

**Finding.** The reserve job only proves that _at least one_ eligible issue
exists; up to four slots then race for the backlog. A slot that legitimately
found the work already claimed reported a no-work at the `query-backlog` stage
with no issue id, and fell into the "invalid no-work with unrecoverable issue
number" branch — an `::error::` and a failed lane for a normal outcome.

**Resolution.** A no-work reported by the **claim stage itself** with no issue id
is deterministic proof that the run claimed nothing, so it returns success with
no mutation, no comment and no error. The check is scoped to `query-backlog`
specifically, and a structural test pins that name to the workflow definition's
first task so a rename cannot silently turn empty slots back into lane failures.
The result-comment step already skipped a run with no numeric issue; that is now
pinned by a fixture rather than assumed.

**Executable regression**: "expected empty slot" runs both the disposition step
and the comment step against a claim-stage no-work journal and asserts exit 0, no
`::error::`, no `gh issue edit`, and no `gh issue comment`.

#### Finding 4 (medium) — the slot deadline reserved no cleanup time

**Finding.** `deadline=$((SECONDS + GOOBERS_SLOT_DEADLINE_SECONDS))` measured 70
minutes from the start of "Run the workflow", but `timeout-minutes` is measured
from **job start**. Checkout, `npm ci`, the Copilot CLI install and four instance
materializations are all inside the job budget and outside that anchor, so a slow
setup pushed the teardown, the journal uploads and every claim/label mutation
toward — and potentially past — the 90-minute ceiling. That is the one failure
mode where the runner kills the job while a provider claim is still held.

**Resolution.** A new first step records `GOOBERS_JOB_START_EPOCH`, and the run
window is derived before any slot starts:

```
run_budget = GOOBERS_JOB_TIMEOUT_MINUTES*60 − elapsed_since_job_start − GOOBERS_CLEANUP_RESERVE_SECONDS
             (capped at GOOBERS_SLOT_DEADLINE_SECONDS)
```

A non-positive budget refuses to start a slot at all rather than starting one the
job could not clean up after. `GOOBERS_JOB_TIMEOUT_MINUTES: '90'` restates
`timeout-minutes` as data (a test pins them together) and
`GOOBERS_CLEANUP_RESERVE_SECONDS: '1200'` is grounded in the sequential worst
case, written out in the workflow: deadline teardown 2 slots × (120 s grace +
15 s verify + slack) = 300 s, host-profile report 15 s, reap 2 × (30 + 15) =
90 s, journal upload 180 s, claim release with three 5 s retries plus timeline/PR
reads 300 s, result comments 120 s, repaired-journal upload plus runner
post-steps 180 s = 1185 s, rounded up.

**Regressions.** A structural test recomputes the teardown worst case from the
literals in the scripts (slot count, both grace periods, the teardown script's
own verification window and sweep slack) and asserts the reserve covers it
together with every cleanup step's enforced `timeout-minutes`, that
`timeout-minutes` equals the restated minutes, and that `slot deadline +
reserve ≤ job budget`. An executable test ("slot deadline cleanup reserve")
drives the real step under an injected clock and asserts the slot is torn down
at the derived deadline — impossible if the declared value were still being
used — plus a second case proving a spent budget refuses to launch anything at
all. See round four, finding 2, for how that reserve became an enforced
ceiling rather than an estimate.

## Fourth review round

A fourth independent review found six more issues (2 high, 4 medium). All six
are fixed here, each with an executable or fixture-driven regression.

### Finding 1 (high) — the reservation receipt did not outlive its Actions run

**Finding.** Round three bound reservation ownership to an adoption/disposal
receipt, but only _within_ a dispatch. Recovery selection still chose targets on
`goobers/status:in-review` alone, so a **later** dispatch would happily re-adopt
an issue whose previous dispatch had left the receipt adopted-but-undisposed —
which is exactly the "the reap failed and a Setsid-detached descendant may still
be pushing" state. An Actions run reports `completed` while such a descendant
keeps working, so "the prior run finished" is not evidence the issue is free.

Worse, the receipt lookup was `contains($marker)` over **every public comment**.
Issue comments are public and the marker text is predictable, so any account
that can comment could forge one. The dangerous direction is a forged
_disposal_: `release-unstarted-reservation` would report "cleanly disposed" and
the next dispatch would re-adopt a live issue. A forged _adoption_ is a cheap
denial of recovery.

**Resolution — one trusted lease library.**
`scripts/agent/goobers-reservation-lease.sh` is now the single implementation of
the marker grammar, the trust rule and the state machine, sourced by all four
steps that read or write a receipt (`Resolve Goobers recovery target`, `Adopt the
reserved recovery target`, `Record reservation disposal`, and the
`release-unstarted-reservation` guard). Two properties make a receipt evidence
rather than a suggestion:

- **Trusted author.** A comment counts only when `user.type == "Bot"` and — when
  the API supplies an app association — `performed_via_github_app.slug ==
"github-actions"`, falling back to the exact `github-actions[bot]` login when
  it does not. That login is unforgeable: `[` and `]` are not legal in a GitHub
  username, so no human account can hold it. An app association that is _not_
  this app is untrusted even if the login matched.
- **Exact marker parsing.** A receipt is recognised only when a **whole line**
  matches the anchored grammar `<!-- crawler-goobers-reservation-{adopted,
disposed}:v1 run-id=<digits> attempt=<digits> issue=<digits> -->`. A quoted
  marker inside prose or a code fence is not a receipt.

**Resolution — run _and attempt_ scoping.** The lease key is `run-id` **and**
`attempt`. Re-running a failed Actions run keeps the same run id, so without the
attempt a re-run's adoption would be closed by the previous attempt's disposal.
A disposal closes only the lease whose key it names.

**Resolution — the gate is now at selection, not just at release.**
`goobers_lease_state` returns the state of the **latest** trusted adoption
(ordered by comment id; the disposal is PATCHed into the adoption comment, so
adoption order and id order agree). Three call sites consume it:

- the scheduled recovery scan **skips** a candidate whose latest lease is
  adopted-and-undisposed, with a `::warning::` naming the reconciliation;
- a directly requested issue (explicit `issue_number`, or the issue that carried
  the label event) **fails loudly** — an instruction is not silently dropped;
- `Adopt the reserved recovery target` re-checks immediately before taking
  ownership, which closes the window between the `reserve` and `run` jobs, and
  refuses on any undisposed lease belonging to a different run/attempt **before**
  it exports any recovery metadata.

Everything fails closed: an unreadable comment list, an empty payload and an
unparsable payload all refuse rather than reading as "this issue is free". Both
the `reserve` and `release-unstarted-reservation` jobs gained a sparse
`actions/checkout` (`scripts/agent`) so they can source the library; both use the
same ref expression as the `run` job's checkout, so a manual dispatch from a
feature branch exercises that branch's own tooling.

**Executable regressions.** The `reservation ownership evidence` and
`durable recovery lease` suites drive the real step scripts against comment
fixtures: an untrusted adoption is ignored (released as if absent); an untrusted
**disposal** does _not_ close a genuine trusted adoption (still refuses); a
marker embedded in a longer line is not a receipt; a lease held by a _different_
dispatch refuses with a distinct message; a re-run attempt is a new lease that
the previous attempt's disposal does not satisfy; unreadable receipts fail
closed; a prior adopted-undisposed lease is skipped by the scan and fails an
explicit request — each with a negative control showing the same fixture is
selected/adopted once the lease is disposed.

### Finding 2 (high) — the cleanup reserve was an estimate, not a ceiling

**Finding.** Four separate gaps let the 90-minute job timeout reach into
cleanup. `GOOBERS_JOB_START_EPOCH` is recorded by the first _step_, but the
runner starts counting `timeout-minutes` before any step exists (scheduling,
runner acquisition, bootstrap), so elapsed time was under-counted. The deadline
loop slept a fixed 10 s, overshooting the deadline by up to a full interval. The
reserve's arithmetic allowed only the teardown script's 15 s verification window
beyond each grace period, with nothing for the /proc sweeps themselves. And no
cleanup step was individually bounded, so one wedged `gh` call could consume the
whole tail.

**Resolution — every component is now an enforced ceiling.**

- `GOOBERS_JOB_START_SLACK_SECONDS: '90'` is added to the observed elapsed time,
  making it an over-estimate. That biases the derived window toward _more_
  cleanup headroom, which is the safe direction.
- The wait sleeps `min(remaining, GOOBERS_SLOT_POLL_SECONDS)`, so it can never
  sleep past the deadline it is waiting for.
- `goobers-stage-teardown.sh` names its two time constants —
  `GOOBERS_TEARDOWN_VERIFY_SECONDS=15` and a new
  `GOOBERS_TEARDOWN_SWEEP_SLACK_SECONDS=30` for the non-sleeping cost of three
  /proc snapshots plus their fixed-point expansions and two signal passes — and
  the reserve arithmetic reads those literals.
- **Every cleanup step declares its own `timeout-minutes`** (host profile 2,
  diagnostics sentinel 1, reap 3, journal upload 4, disposition 5, repaired
  upload 4, result comments 3, disposal receipt 2 = 24 min). This is the change
  that turns the reserve from a hand-summed estimate into a proof: the runner
  bounds each step itself, so a wedged step is killed by its own bound and the
  steps after it still run.
- `GOOBERS_CLEANUP_POST_STEP_SECONDS: '180'` accounts for the runner's post-job
  steps, which are inside `timeout-minutes` but bounded by no step of ours.

The budget is pinned by a structural test that recomputes it from the workflow's
own literals: `330` (deadline teardown, 2 slots × (120 + 15 + 30)) + `1440`
(sum of cleanup `timeout-minutes`) + `180` (post-steps) = `1950` ≤
`GOOBERS_CLEANUP_RESERVE_SECONDS: '2100'`, and `GOOBERS_SLOT_DEADLINE_SECONDS:
'3300'` + `2100` = the full `5400` s job budget. The cleanup steps are
enumerated **by position** (everything from the host-profile report onward), so a
newly added cleanup step cannot escape the budget by not being on a list. A
further assertion pins the reap's own ceiling against the sweep it performs.

**The trade, stated plainly.** Making the reserve real cost run time: the slot
deadline drops from 4200 s to 3300 s, and the effective window after a typical
5-minute setup is about 48 minutes rather than about 65. That is deliberate — the
failure this arithmetic exists to prevent is the runner killing the job while a
provider claim is still held, and a shorter run is strictly cheaper than that. If
48 minutes proves too tight for a full plan → implement → review → PR loop, the
correct lever is raising `timeout-minutes` (and its restated
`GOOBERS_JOB_TIMEOUT_MINUTES`), **not** shrinking the reserve; the structural
test will accept the former and reject the latter.

**Regressions.** "slot deadline cleanup reserve" now runs under an injected
clock (see finding 5) and asserts the derived window includes the startup
allowance, and a new case proves a 3 s window with a 30 s poll interval still
tears down at ~3 s — impossible with a fixed-interval sleep.

### Finding 3 (medium) — a failed backlog read looked like an empty backlog

**Finding.** Both scans were `for candidate_issue in $(gh …)`, which throws the
command's exit status away. An auth failure, an API outage or a secondary rate
limit produced an **empty** candidate list, and the step read it as "no recovery
work" (silently skipping live recovery) or "no eligible work" — the second is
worse, because it sets `should_run=false` and skips the entire `run` job while
the backlog is full.

**Resolution.** A `list_backlog_candidates` helper runs the command with an
explicitly checked assignment and iterates the captured output through
`while … done <<<"$candidates"`. stderr is captured to a **separate file**, never
folded into the list: `gh` writes advisory notices to stderr on _successful_
calls, and a spliced notice would be handed to the PR and blocker lookups as an
issue number. Each candidate is then checked numeric by
`require_candidate_number` before use. The three `find_open_dependency_blockers`
call sites are explicitly checked too, so an unreadable dependency list can no
longer read as "unblocked". Every failure names
`gh api rate_limit --repo <repo>` as the diagnosis command.

**Executable regressions** ("backlog read failures"): the recovery scan and the
fresh scan each fail closed with the right message and without emitting
`should_run=false`; a negative control shows a readable scan still reports an
eligible backlog; a stderr notice on a successful call never reaches the
candidate list; and a non-numeric response refuses rather than being acted on.

### Finding 4 (medium) — the artifact the messages point at might not exist

**Finding.** Both journal uploads globbed `slot-*/gaggles/*/runs/`, which matches
only when a slot actually produced a journal. The synthetic no-journal
disposition and result-comment records exist precisely for the case where none
did — and they name that artifact. Those pointers were dangling, and
`if-no-files-found: warn` said so only in the log.

**Resolution.** A new `Write slot diagnostics sentinel` step (`always()`,
`timeout-minutes: 1`, positioned after the reap and before both uploads) writes
`<slot root>/diagnostics/slot-diagnostics.txt` for **every** slot, carrying the
lane, slot, instance root, workflow, Actions run and attempt, reap outcome,
recovery issue, and the journals it found — or an explicit
`(none — this slot produced no run journal)`. Both artifacts now list the
diagnostics directory alongside the run trees and use
**`if-no-files-found: error`**, which is correct precisely because the sentinel
makes the match unconditional: a missing artifact is now a failure rather than a
warning nobody reads. The result comment names the file by path.

**Executable regressions** ("slot diagnostics sentinel"): the sentinel is written
for every slot when nothing ran at all and carries the identifying fields; and
when a slot did produce a journal it is listed while its sibling still reports
`(none)`. A structural test pins the step's position before both uploads, both
`path:` entries, and `if-no-files-found: error` on both.

### Finding 5 (medium) — the cleanup-reserve test raced the wall clock

**Finding.** The test computed `GOOBERS_JOB_START_EPOCH` from `Date.now()` in the
test process, and the step read `date +%s` again in bash. Those two reads
straddle a second boundary often enough to matter, so `60s already spent` was
intermittently `61s`.

**Resolution.** The harness shadows `date +%s` with a shell function pinned to a
fixed instant — the same stubbing mechanism it already uses for `gh`, `goobers`
and `sleep` — and delegates every other `date` invocation to the real binary.
**No production behaviour changed**: there is no test-only branch, no override
env var, and nothing in the workflow reads a clock differently. `SECONDS` (which
drives the actual deadline loop) is untouched, so the teardown still runs against
real elapsed time and the test still proves a real process was killed.

### Finding 6 (medium) — the rootless cancellation reap was never executed

**Finding.** The deadline path passes each slot's `goobers run` pid as a root, so
the /proc ppid closure alone finds the tree, and that is the path the existing
test exercised. The `always()` reap has **no root**: on a cancelled or failed job
the `goobers run` process is already gone and Actions has terminated the step's
own process group, which never reaches a Setsid-detached stage. The only thing
left that identifies a survivor is the inherited `GOOBERS_INSTANCE` — and nothing
executed that path.

**Resolution.** A new `rootless cancellation reap` suite runs the **exact**
`Reap surviving Goobers stage processes` step script against a real
`setsid`-detached descendant carrying `GOOBERS_INSTANCE`, whose launcher has
already exited (so it is reparented to init with no ppid path back to anything).
It asserts the step exits 0, reports `stage tree fully terminated`, the orphan is
dead, its heartbeat has **stopped** (not merely become unsignalable), and an
unrelated bystander process in another session survives untouched — selection is
by identity, never by process name.

A second case proves the failure **propagates**. `kill` is shadowed for the whole
step, so the real teardown library runs unchanged, finds the orphan, "signals"
it, and then correctly refuses to report success because the process is still
alive; the step exits non-zero with the `is being SKIPPED` error that
`Handle no-work disposition` gates on. (`sleep` is shadowed only to collapse the
30 s grace and 15 s verification windows.) That is deterministic failure
injection at the one point that can actually fail in production — signal
delivery — rather than a mock of the thing under test.

**CI now guarantees these run.** The suite is gated on `/proc` and `setsid` so a
Windows workstation reports a skip rather than a false failure, and that gate is
exactly what could silently disarm the suite on the runner enforcing the
contract. `goobers-contract-validation.yml` gained a
`Prove the Linux-only executable suites can run here` step that fails loudly if
`jq`, `setsid` or `/proc` is missing, and sets
`GOOBERS_REQUIRE_LINUX_SUITES: '1'`, which makes the suite itself assert it
really ran. Both shell libraries were added to the workflow's path triggers. A
structural test pins all of it.

## Fifth review round (post-sync, on `90fe8035d` / rebased `b57f0dc6a`)

Six findings from the independent review that ran after the main sync. All six
are fixed at their root cause in this branch; none is deferred or suppressed.

### Finding 1 (high) — a disposal receipt was accepted from any trusted comment

**Finding.** `goobers_lease_state` collected disposal receipts across **every**
trusted comment and closed the latest adoption if any of them named its
run/attempt. Author trust was doing all the work — and it is not enough here,
because this workflow posts more than one Actions-authored comment on the same
issue, and one of them (`Comment on Goobers run result`) renders **free-form
Goobers journal text** into its body. Journal text is written by the agent under
test, not by the workflow. `jq -r` emits embedded newlines verbatim, so a stage
error message containing
`…\n<!-- crawler-goobers-reservation-disposed:v1 run-id=<id> attempt=<n> issue=<n> -->\n…`
rendered as a standalone, whitespace-trimmed marker line inside a comment the
lease library trusts by author. That closes a live lease, and the next dispatch
re-adopts an issue whose stage tree may still be pushing — the exact two-agents
failure the whole lease exists to prevent.

**Resolution — both halves.**

_Reader (the half that does not depend on future comment writers):_ a disposal
now counts only when it lives in **the adoption's own comment body**. The jq
prelude's cross-comment `$disposed` set is gone; each adoption carries a
`disposed:` field computed from `$comment.receipts` alone, matched on the same
run **and** attempt. So a perfectly formed disposal in any other comment —
trusted author, correct key, whole line, inside or outside a code fence — is
inert.

_Writer:_ both writers now resolve the receipt comment through
`goobers_lease_state`, the same function the guards read, so "the comment a
disposal is written into" and "the comment a later read sees it in" are the same
comment by construction. `Adopt the reserved recovery target` takes the receipt
id from the lease record instead of searching for a standalone marker, and
`Record reservation disposal` PATCHes `lease_comment` only after asserting the
latest trusted adoption is this run **and** attempt (with an idempotent
`already recorded` exit when it is already disposed). `goobers_lease_receipt_id`
— the standalone marker search that could resolve to the wrong comment — was
deleted rather than narrowed.

_Source:_ the journal text can no longer produce the injected line at all. The
`terminal_summary` jq gains `gsub("[\r\n]+"; " ")`, and `.type` is already
pinned to three literals by the surrounding `select`, so every rendered line
begins with a workflow-controlled token and the anchored marker grammar cannot
match it. (This also fixes a latent bug: a multi-line message used to inflate
the `tail -n 8` window.)

**Executable regressions.** `ignores a disposal in a TRUSTED comment that is not
the adoption receipt`; `ignores a disposal rendered inside a trusted result
comment's journal block` (the literal fenced-and-indented shape the result step
emits); `negative control: the same disposal DOES close the lease inside the
receipt` (byte-identical marker, moved into the adoption comment — without it
the two tests above would pass on a reader that ignored disposals entirely);
`PATCHes the disposal into the adoption receipt the guards will read`; `refuses
when the latest trusted adoption is not this dispatch's`; and
`collapses embedded newlines so a journal message cannot render a marker line`,
which runs the real result-comment step against a journal carrying the
injection and asserts no line of the posted body equals the marker. Structural
tests pin the same-comment jq, the absence of the old `$disposed` set, and that
neither writer uses a standalone marker search.

### Finding 2 (high) — both artifact uploads found zero files, every run

**Finding.** `GOOBERS_LANE_ROOT` is `${{ github.workspace }}/.goobers-lane-<n>`,
a **dot directory**, and it is the least common ancestor of both upload globs —
so it is the traversal root `actions/upload-artifact` starts from.
`@actions/glob` skips any item whose basename starts with `.` unless hidden
files are included, and (verified in `internal-globber.ts`) it applies that test
to the search root itself before descending. With `include-hidden-files`
defaulting to false, the globber refused to descend at all, found zero files,
and — because round four had correctly tightened both uploads to
`if-no-files-found: error` — **failed every single run**, taking the journals
with it.

**Resolution.** `include-hidden-files: true` on both uploads, with the reason
stated inline. The root was not un-hidden instead: the dot prefix is what keeps
four slot trees out of the repo working copy's own tooling.

**Regression.** The artifact contract test now asserts `include-hidden-files:
true` on both uploads _and_ that `GOOBERS_LANE_ROOT` really is a dot directory,
so the assertion cannot become vacuous if the root is renamed.

### Finding 3 (medium) — a re-run collided with its own first attempt

**Finding.** Artifact names carried `github.run_id` but not
`github.run_attempt`. Artifact names are unique per **run**, not per attempt, so
re-running a failed run made attempt 2's upload collide with attempt 1's — and
the failure landed on the journals of the very attempt someone re-ran to
diagnose.

**Resolution.** Both upload names, the `ARTIFACT_NAME` env the result comment
renders, and every free-text artifact reference inside the step scripts
(`Run the workflow`'s deadline and slot-exit errors, the terminal-journal
barrier's repaired-artifact pointer) now carry `-${{ github.run_attempt }}` /
`-${GITHUB_RUN_ATTEMPT}`. The result-comment marker is attempt-keyed too, so a
re-run posts its own comment instead of overwriting attempt 1's pointer at
attempt 1's artifact.

**Regressions.** A new structural test renders both names across two lanes × two
attempts and asserts four distinct names per template, pins `ARTIFACT_NAME` to
the upload's own `name:`, and — the part that actually rots — sweeps **every**
`goobers-run…${GOOBERS_WORKFLOW}…` reference out of every step script and
requires each to name `${GITHUB_RUN_ATTEMPT}`.

### Finding 4 (medium) — a sibling slot's journal masked the recovery slot's absence

**Finding.** Both post-processing steps synthesized a record for the reserved
issue only when the **lane** produced no journal at all
(`[ ! -s "$run_records" ]`). The reservation belongs to exactly one slot, so a
healthy sibling slot's journal satisfied that check: the reserved issue received
no disposition and no terminal comment, while the step still exited 0. `Record
reservation disposal` is gated on that exit status — so it then wrote a disposal
receipt claiming a clean hand-back that had never happened, publishing a
possibly-live issue to the next dispatch.

**Resolution.** Journal presence is tracked for the **recovery slot
specifically** in both steps: an `awk` presence check on the slot column of
`run_records`, so the synthetic record is appended whenever that slot has none,
sibling journals notwithstanding. The disposition step additionally **asserts**
the outcome rather than assuming the enumeration: it counts a
`recovery_processed` record and fails with a named reconciliation command if the
reserved issue was never dispositioned. Disposal therefore follows a recovery
disposition that actually ran.

**Executable fixtures** (`journal-less recovery slot`): the recovery slot
journalless with a sibling journal present — the issue is dispositioned
(`Slot 1 run <no journal>: issue=#42`, label released) and gets its own terminal
comment alongside the sibling's; plus a negative control proving a recovery slot
that _did_ produce a journal is processed exactly once, which an unconditional
synthesis would have double-counted.

### Finding 5 (medium) — the step blocked on a root the teardown could not kill

**Finding.** After `terminate_slots` failed, the step still ran
`wait "$pid"` on every slot unconditionally. A root the teardown could not kill
may never exit, so that `wait` burns the whole 2100 s cleanup reserve and then
the 90-minute job timeout kills the job mid-flight — the single path that skips
the reap, both uploads and every claim/label mutation, stranding a provider
claim on a live issue. The teardown's careful fail-closed reporting was being
undone by the line after it.

**Resolution.** The blocking `wait` is reachable only for a slot the teardown
proved clean — either no deadline fired and `slots_alive` went false, or that
slot's tree verified as gone after SIGKILL — so it returns immediately with the
slot's real exit status. A slot the teardown could not prove clean is recorded
as failed **now**, with an `::error::` naming the pid it is deliberately not
waiting on, and the step exits non-zero. The refusal is tracked **per slot**
(`unreaped_slots`), not as one lane-wide flag: a lane-wide flag would report a
healthy sibling slot as unreaped too, sending a human to hunt a process that is
not there and discarding that slot's real exit status. The always()-gated
`Reap surviving Goobers stage processes` step then runs and is still the
authority on whether anything may be released.

**Executable regression** (`fails promptly instead of waiting on a root the
teardown could not kill`): two slots — slot 1 never returns, slot 2 exits 0.
`kill` is shadowed for TERM/KILL only — `kill -0` passes through, so
`slots_alive` still observes truth and the real teardown library runs unchanged,
finds slot 1's root, "signals" it and correctly refuses to report success. The
test asserts the step exits non-zero naming **slot 1** specifically, that slot 2
is neither blamed nor stripped of its `exited 0`, that the surviving root is
**still alive** after the step returned (a blocking `wait` could only have
returned after the stub's 600 s sleep), and that the step returned well inside
that window.

### Finding 6 (medium) — a recycled root pid could be swept

**Finding.** The deadline path seeded the sweep with a bare `goobers run` pid,
up to ~55 minutes after that pid was launched. Linux recycles pids, so by then
the pid may belong to an unrelated process — plausibly one of the Actions
runner's own. Seeding from it would signal that process, its ppid closure, and
(through the session axis, which is seeded _from members_) its entire session.
The per-signal start-time guard already in `goobers_teardown_signal` did not
help: it re-read the start time of whatever held the pid at signal time, so a
recycled process was consistent with itself.

**Resolution — an explicit root schema.** Every root is now
`<pid>:<start-time>`, where the start time is /proc stat field 22 read
**immediately after** the launch that produced the pid, by the same library
function the sweep verifies against:

```bash
slot_pid=$!
slot_start="$(goobers_teardown_pid_start "$slot_pid")"
…
goobers_teardown_tree "$slot_root" 120 "${slot_pid}:${slot_start}"
```

`(pid, start time)` is unique for the lifetime of a boot. `goobers_teardown_tree`
rejects a bare pid outright with exit 2 and usage text (a caller cannot silently
regress to the unsafe form), and `goobers_teardown_members` seeds a root only
when the live process matches: **absent** → skipped silently (it already exited,
which is the normal path); **present with a different start time** → skipped
with a `::warning::` naming both start times, so neither it nor its session ever
enters `members`. Env-root discovery is untouched — a true descendant of the
original root still carries `GOOBERS_INSTANCE` and is still found.

The teardown library is now sourced **before** the slot-launch loop (it was
sourced just before the deadline loop), the slot table carries a fifth
`start` column, and all three table readers bind it. The start-time field
arithmetic moved into one `goobers_teardown_pid_start` function shared by the
launch site, the signal pass and the liveness count, so a writer and a reader
cannot disagree about which /proc field a "start time" is.

**Executable regressions** (`root pid reuse`): a real live process leading a
child of its own, no `GOOBERS_INSTANCE`, handed to the teardown with a
deliberately wrong expected start time — the exact observable state a recycled
pid presents. The sweep declines the root with the recycling warning, exits 0,
and **both the replacement and its child survive**. The positive control runs
the identical setup with the correct start time and asserts the same two
processes are torn down, so the negative case proves the guard rather than an
inert sweep. A third test pins the bare-pid usage refusal (exit 2). Structural
tests pin the schema, the seed verification, the launch-site capture and its
ordering, the table's fifth column, and that the field arithmetic exists exactly
once.

## Why separate instance roots, not a daemon

Verified against the pinned `goobers-dev-6d33b160` source. A bare `goobers run`
acquires `<root>/scheduler/up.lock` and holds it for its entire blocking wait
(`cmd/goobers/run.go`), so two runs can only overlap if they are two different
instances. Everything mutable is rooted at the instance root:

- `SchedulerDir() = <root>/scheduler` — the instance lock, claim ledger
  (`claims.json`) and claim lock (`internal/instance/instance.go`).
- `WorkcopiesDir() = <root>/gaggles/<gaggle>/workcopies` — the git worktrees and
  their `auth/` GIT_ASKPASS helper (`cmd/goobers/runnerwiring.go`,
  `runnerwiring_credentials.go`). No global git config is touched
  (`GIT_CONFIG_GLOBAL` is only set to `/dev/null` in Goobers' own subprocesses).
- `TelemetryDB()`/`ReadDB()`/`IntakeDB()` per root, and the standalone read-model
  projection is keyed by a hash of the instance root specifically so that
  "two instances on one machine" do not share a store
  (`internal/readservice/topology.go`).

Run ids are 128-bit crypto-random (`internal/telemetry/client.go`'s `NewRunID`)
and branch names embed them (`providers.BranchNameIn`), so four concurrent runs
cannot collide on a branch. Claim uniqueness across the four roots is
provider-side, not just the local ledger: `ClaimWorkItem` stakes a breadcrumb
comment and settles the race by minimum comment id
(`providers/github_issues.go`), and a loser releases and advances to the next
eligible item (`cmd/goobers/backlogquery.go`'s `confirmProviderClaims` +
`collect`).

The recovery path is the one claim that does **not** go through that protocol —
`crawler-feature-pr.yaml`'s query-backlog recovery branch just labels the issue
— which is why the `reserve` job reserves the target with
`goobers/status:in-review`, and confirms it, before either lane exists, and why
`excludeLabels` had to start working.

`readiness.desiredConcurrentRuns` remains unused: it only wires a demand counter
for a `backlog-item` (or schedule + update-behind-pr) trigger
(`cmd/goobers/runnerwiring_counters.go`), and a `manual`-only trigger never gets
one.

## Verification

Counts below are the post-fifth-round state.

- `npx vitest run tests/unit/goobers-run-workflow.test.ts` (41 passed) —
  structural: lane/slot shape, hard max 4, no `goobers up`, per-slot instance
  isolation, `needs: reserve` ordering and single-writer reservation, the
  cross-dispatch recovery single-flight and its `actions: read` permission, the
  run+attempt-scoped adoption/disposal receipt chain and the guard that
  consumes it, the lease library's trust rule, anchored marker grammar and
  **same-comment disposal rule**, both writers resolving the receipt through
  that one reader, the journal-text newline collapsing at the render site, the
  unstarted-reservation guard's full non-success result set, the derived slot
  deadline with its startup allowance and its enforced-ceiling cleanup reserve,
  whole-tree deadline teardown wiring with the **`<pid>:<start-time>` root
  schema** and its launch-site capture, the **non-blocking wait** after a failed
  teardown (tracked per slot, so a healthy sibling keeps its exit status), the
  reap-outcome gate on disposition, the terminal-journal and
  claim-release barriers, the guaranteed diagnostics sentinel with
  **`include-hidden-files: true`** and `if-no-files-found: error` on both
  artifacts, **per-attempt artifact naming** across every upload, env and
  free-text reference, the **per-recovery-slot** journal synthesis in both
  post-processing steps and the disposition step's assertion that it ran, the
  fail-closed backlog scans, the expected-empty-slot outcome and its
  claim-stage-name pin, the teardown script's identity-only selection and
  fail-closed snapshot handling, recovery scoping, exhaustive enumeration, and
  the contract-validation job's enforcement that the Linux-only suites really
  run.
- `npx vitest run tests/unit/goobers-run-slot-cleanup.test.ts` (65 tests: 63
  passed, 2 skipped locally — see the residual note) — **executable**: extracts
  the real step scripts from the workflow and runs them under bash against
  fabricated instance trees and real processes with stubbed `gh`/`goobers`.
  Proves (a) both slots start before either finishes (`start,start,end,end`),
  (b) distinct per-slot instance roots, (c) exactly one recovery slot, (d) one
  claim release per run id, (e) `goobers run abort` before that run's claim
  release, (f) correct per-run label disposition including a run with no
  `run.finished` while the lane-wide status is `failure`, (g) one distinctly
  keyed result comment per run, (h) the reservation interleaving with its
  negative control, (i) the deadline path killing a session-detached descendant
  while leaving an unrelated process alive, (j) the teardown's fail-closed
  snapshot guards and its refusal of a bare root pid, (k) the three
  terminal-repair/claim-release failure shapes mutating nothing, (l) an expected
  empty slot as a clean no-claim, (m) the derived slot deadline governing over
  the declared one under an injected clock, refusing to launch on a spent
  budget, and never sleeping past its own deadline, (n) the cross-dispatch
  single-flight through the workflow's own jq filter with a negative control,
  (o) every reservation-lease state the guards act on — including an untrusted
  spoofed adoption, an untrusted spoofed **disposal** against a genuine
  adoption, a **trusted unrelated** disposal, a **disposal injected through a
  journal code block**, a substring-only marker, a lease held by a different
  dispatch, and a re-run attempt as a new lease, each with a negative control,
  (p) both backlog scans failing closed on an API error plus stderr-splicing and
  non-numeric-response refusals, (q) the diagnostics sentinel for
  journal-bearing and journal-less slots, (r) the rootless cancellation reap
  killing a `setsid` orphan found only by `GOOBERS_INSTANCE`, sparing a
  bystander, and propagating a non-zero exit when a survivor cannot be
  terminated, (s) **a recycled root pid and its whole session surviving the
  sweep**, with a matching-start-time positive control that tears the same tree
  down, (t) **the step failing promptly instead of waiting on a root the
  teardown could not kill**, naming only the slot that actually failed while a
  healthy sibling keeps its `exited 0`, with the survivor still alive after it
  returned,
  (u) **the reserved issue being dispositioned and commented on when its own
  slot produced no journal but a sibling slot did**, with a no-double-count
  negative control, and (v) **a journal message carrying an embedded marker
  never rendering it as a line of its own**.
- `npx vitest run tests/unit/goobers-contracts.test.ts tests/unit/goobers-shadow.test.ts tests/unit/goobers-lifecycle-ownership.test.ts`
  (all Goobers suites together: 170 passed, 2 skipped).
- `node --test .github/scripts/ci-recovery/router.test.mjs` (149 passed) — the
  managed-marker inventory covers the two reservation markers.
- YAML parse of all five Goobers workflow/gaggle/instance files plus `bash -n`
  of all 35 embedded `run:` step scripts, and of
  `scripts/agent/goobers-stage-teardown.sh` and
  `scripts/agent/goobers-reservation-lease.sh`.
- Direct bash smoke runs of the lease library's state machine against eight
  same-comment fixtures (adoption only, adoption+disposal in one comment,
  disposal in a different trusted comment, disposal inside a trusted code
  fence, empty, older-attempt-disposed plus newer-attempt-adopted, untrusted,
  unparsable) — cases 3 and 4 are the ones the fifth round's finding 1 turns
  from "released" into "still held".
- `npm run test:guards` (2866 tests, 2850 passed, 0 failed, 16 skipped),
  `npm run docs:check` (0 blocking), `npm run verify:fast`,
  `npm run verify:pr-prereqs`.
- A local `jq` (1.7.1) was installed on PATH before these runs specifically so
  no jq-gated case could silently skip.

## Main sync (2026-09-04, rebase onto `f9604172c`)

Rebased onto `origin/main` at `f9604172c`, which had advanced by three merges —
notably #4091 ("Hand Goobers the pre-PR implementation claim with no automation
downtime"), which touches the same two files this branch does.

**Conflicts, all in `.github/workflows/goobers-run.yml`, all resolved
semantically (never `ours`/`theirs`):**

- Main added a lifecycle-ownership gate to the job `if:`
  (`vars.LIFECYCLE_MUTATION_OWNER == 'goobers' && (...)`) so a rollback to
  `legacy` cannot leave Goobers and legacy intake dual-claiming an issue. This
  branch had split that single `run` job into `reserve` + a two-lane matrix
  `run`. The gate now lives on **`reserve`**, which is strictly stronger than
  main's placement: every `run` leg declares `needs: reserve` with a plain
  (implicitly `success()`) condition, so a skipped reservation skips all four
  slots. Checked the interaction with `release-unstarted-reservation`, which is
  `always()`-gated: a skipped `reserve` exposes no outputs, so its
  `needs.reserve.outputs.recovery_issue != ''` guard is false and it too skips.
  No dangling label mutation on the rollback path.
- The `strategy`/`concurrency` blocks that main's context carried along stayed
  with `run` where this branch moved them; main's comment explaining the
  ownership gate moved with the `if:` it explains.

`.github/scripts/ci-recovery/markers.mjs` auto-merged: main's
`LIFECYCLE_LEASE_*` constants and this branch's `GOOBERS_RESERVATION_*` markers
are both present and both registered in `MANAGED_COMMENT_MARKERS`.

**One real behavioral incompatibility, fixed at its root:** main's new
`tests/unit/goobers-lifecycle-ownership.test.ts` asserted
`claim.inputs.excludeLabel === 'goobers/status:in-review'` — the **singular**
key. This branch had already renamed that input to the plural `excludeLabels`
because the singular spelling is read by nothing. Verified against upstream
rather than trusting either comment: `cmd/goobers/backlogquery.go` does
`splitLabelList(providerInput("excludeLabels", ""))` and
`api/validate/validate.go` validates `task.Inputs["excludeLabels"]`. So main's
assertion was pinning a no-op and "proving" an exclusivity property that did not
actually hold at runtime.

The gate was fixed, not relaxed: the test now asserts membership of
`goobers/status:in-review` in the parsed `excludeLabels` list (so additional
exclusions such as `completed-existing-work` remain allowed) **and** asserts the
inert singular key is absent, so the no-op spelling cannot come back. Main's
invariant — the claim excludes the label it sets, and is therefore
self-excluding — is preserved and is now actually enforced.

**Post-sync revalidation:** focused Goobers suites
(`goobers-run-workflow`, `goobers-run-slot-cleanup`,
`goobers-lifecycle-ownership`: 118 passed, 2 skipped), router marker test (149
passed), YAML parse of all six touched workflow/gaggle files, `bash -n` on both
branch scripts plus all 25 embedded `run:` step scripts in `goobers-run.yml`,
`npm run docs:check` (0 blocking), `npm run verify:fast`, and
`npm run verify:pr-prereqs` — all green, with `jq` 1.7.1 on PATH.

## Residual notes

No unresolved correctness caveat: every independent-review finding above — all
**five** rounds — is fixed in this branch, not deferred. The notes below are
operating characteristics of the approved design, or honest limits of local
verification.

- **The two `rootless cancellation reap` tests are the only cases that skip on
  this workstation**, because Git-Bash ships no `setsid`. Their logic was
  verified locally with an equivalent no-`setsid` orphan (MSYS2 exposes
  `/proc/<pid>/environ`, so the `GOOBERS_INSTANCE` selector is exercised
  identically): the step killed the orphan, spared the bystander and exited 0,
  and the injected-failure variant exited 1 with the `is being SKIPPED` error.
  The `setsid`-specific session axis is exercised for real only on
  `ubuntu-latest`, which is now enforced rather than hoped for —
  `goobers-contract-validation.yml` fails outright if `setsid`, `jq` or `/proc`
  is missing, and `GOOBERS_REQUIRE_LINUX_SUITES=1` makes the suite assert it
  did not skip. The new `root pid reuse` suite deliberately does **not** require
  `setsid`: it falls back to a reparented leader-and-child pair, so the pid
  identity guard is executed on every host, and the session axis is additionally
  exercised on Linux.
- **The per-slot run window is shorter than before**: ~48 minutes effective
  after a typical setup, down from ~65. That is the deliberate price of making
  the cleanup reserve an enforced ceiling (round four, finding 2). The lever if
  it proves too tight is `timeout-minutes`, not the reserve.
- **The lease grammar has no migration path, and needs none.** A receipt written
  in the round-three format (no `attempt=`) would not parse, and would read as
  "no lease". No such receipt exists: this branch is unmerged and the receipt
  mechanism has never run against the live repository. If that changes before
  merge, the safe action is to clear any stray receipt comment by hand.
- **An untrusted adoption is ignored rather than escalated.** A stranger who
  posts a perfectly formed adoption marker cannot wedge recovery — correct — but
  also produces no signal. Adding a "someone is forging our markers" notice was
  considered and rejected as noise; the router already suppresses
  `<!-- crawler-` comments, so a forgery is inert.
- Two concurrent full `npm run verify:fast` + Copilot CLI stages per
  GitHub-hosted runner is a real resource increase. This is the explicitly
  approved metric, not an accident; watch host-profile output
  (`goobers-run-lane-<n>`) on the first live dispatch and lower
  `GOOBERS_SLOTS` to `'1'` if a lane starts thrashing.
- The ownership barriers are deliberately biased toward preserving labels. A
  failed reap, a failed terminal repair or a failed claim release leaves
  `goobers/status:in-review` (and possibly `goobers:claimed`) set until a human
  clears it — and, since round four, also blocks the **next** dispatch from
  selecting that issue. That is the intended trade: a preserved label costs one
  manual `gh issue edit` that every error message spells out, while releasing
  early costs two agents pushing to one issue.
- While a dispatch is live, a later dispatch does no recovery work — it still
  claims fresh backlog items, and the hourly sweep picks the recovery target up
  once the live dispatch finishes. That is the cost of one dispatch owning at
  most one recovery reservation.
- The npm cache (`~/.npm`) is shared by the two slots on a runner. npm's
  content-addressed `cacache` is concurrency-safe by design, so it is not
  isolated per slot; if a concurrent `npm ci` ever proves flaky, set
  `npm_config_cache` per slot and add it to `envPassthrough`.
- `goobers-stage-teardown.sh` is Linux-only by construction: it reads `/proc`.
  That is the platform the Goobers slots run on, and it says so with an
  actionable `::error::` rather than failing obscurely elsewhere.
- **A root pid that has already exited by the time the sweep runs is skipped
  silently, not warned about.** That is the normal path — the root exits first
  on every healthy run — and any descendant it left behind is still found by
  `GOOBERS_INSTANCE`. Only a pid that is _present with a different start time_
  (a genuine recycle) produces the `::warning::`.
- **The teardown's grace period is per slot, sequential.** The pid-identity
  check adds one extra `awk` read per root per snapshot, which is noise against
  the existing full-/proc sweep; the cleanup reserve arithmetic is unchanged and
  a structural test still recomputes it from the workflow's own literals.
- The `reserve` and `release-unstarted-reservation` jobs now do a sparse
  `actions/checkout` of `scripts/agent` so they can source the lease library.
  That is a few seconds each, well inside their 20- and 10-minute budgets, and
  it is what keeps the trust rule and marker grammar from being duplicated
  inline in four places.

## Apples

Estimated 3, actual 3 — exact. Tooling-only workflow/config/test change, capped
per the DevOps persona's tooling ceiling regardless of the amount of upstream
source verification required to ground the design, and regardless of the
post-review rework (a preflight reservation job, a process-tree teardown script,
a trusted durable-lease library, and **five** rounds of review fixes covering
reservation ownership evidence, cross-dispatch lease durability, marker
spoofing, journal-text marker injection and same-comment disposal binding,
terminal-repair barriers, empty-slot handling, fail-closed backlog reads,
guaranteed and hidden-file-inclusive diagnostics artifacts, per-attempt artifact
naming, per-recovery-slot disposition, non-blocking teardown failure, root pid
identity, deterministic clock injection and the rootless cancellation reap)
folded into the same change.
