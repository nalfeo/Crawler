# Handoff: Trusted review-wake bridge

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated and actual — the explicit human cap for one `ci-policy` subsystem:
a new trusted workflow bridge and policy module with deterministic policy/wiring
coverage and a two-round review-harness loop. The raw file count includes
required audit artifacts and shepherding cleanup rather than a second system.

## What changed

- Added `CI Recovery Review Wake Bridge`, a `workflow_run` listener scoped only
  to completed `CI Recovery Router` runs. Read-only inspection and the
  write-capable dispatch are separate jobs.
- Added canonical run re-fetch and a fail-closed policy requiring the exact
  router name/path, `completed/action_required`, review/review-comment source,
  the production-proven Copilot bot ID/login/type for both actor fields, and a
  same-repository open PR on `main` at the exact run head SHA.
- The bridge binds recovery to one source PR. (Superseded — see the
  2026-07 amendment below: the original `workflow_run.pull_requests`
  "identifies the exact source PR" assumption was corrected, because that
  array is head-SHA/branch association, not event-to-PR provenance.)
- PRs that modify or rename the router, bridge, or recovery workflows are
  rejected. The accepted path emits one PR number and the write-only job makes
  one targeted `ci-recovery.yml` reconciliation dispatch; it never invokes the
  router or a sweep.
- The bridge threads the validated head SHA through its inspection output and
  the dispatch's `expected_head_sha` input. `ci-recovery.yml`/`reconcile.mjs`
  fail closed (skip without mutating) when the live PR head no longer matches
  that validated SHA, closing a time-of-check/time-of-use race in which a
  synchronize after inspection could move the head onto a commit that edits a
  protected workflow — the protected-file gate only runs in the bridge, against
  the reviewed head. An empty input preserves normal manual/router behavior.
- Documented the trust boundary, recursion exclusion, default-branch
  registration constraint, and targeted operator fallback.

## Trust and token decisions

- Production parked runs identify the reviewer as `Copilot`, bot ID
  `175728472`; no display-name-only trust is accepted.
- The final dispatch uses `GITHUB_TOKEN`, not the repository App token. GitHub
  exempts `workflow_dispatch` from `GITHUB_TOKEN` recursion suppression, the
  existing router uses this path, and the repository App token is documented to
  receive 403 responses from workflow-dispatch endpoints.
- The dispatch job has only `actions: write`. It cannot read repository
  contents or PR metadata. The inspection job has no write permission.
- Recursion is structurally excluded: the bridge listens only to `CI Recovery
Router`, dispatches `CI Recovery`, and cannot match its own completion.

## Validation and observation

- Before: production recorded 228 router runs in 20.4 hours that were triggered
  by Copilot review/review-comment events and concluded `action_required`.
- After (deterministic): the synthetic trusted parked wake resolves PR #42 and
  the real workflow dispatch script makes exactly one call to
  `ci-recovery.yml`; success, non-review, untrusted actor, human rerun, fork,
  ambiguous PR, stale SHA, incomplete files, and protected-workflow changes
  dispatch nothing.
- Full CI-recovery policy/router/state suite: 168 tests, 126 passed, 42 known
  Windows `UV_HANDLE_CLOSING` subprocess-shutdown skips, 0 failed.
- Workflow wiring suite: 8/8 passed.
- Combined policy/wiring validation: 176 tests, 134 passed, 42 known Windows
  skips, 0 failed.
- `npm run typecheck`
- `npm run verify:fast`
- Review harness: separate-model plan review produced four resolved concerns and
  the production evidence forced a `plan_divergence=major_fork`. Code-review
  round 1 produced two resolved concerns. Round 2 found one live-state ownership
  concern spanning two release call sites; both were fixed, and focused
  independent follow-up validation was clean. A later PR security review found
  the privileged execution boundary omitted scripts and the auto-rebase sink;
  the exact 12-path boundary was added and independently reviewed clean.

## GitHub platform caveat

GitHub registers `workflow_run` listeners only from the default branch, so this
feature branch cannot produce the final live delivery proof. After merge, the
first Copilot-authored parked router review run must create one bridge run and
one targeted CI Recovery run. If GitHub does not emit that `workflow_run`
event, or emits it without a PR association, use the documented targeted
`gh workflow run ci-recovery.yml` fallback; do not wait for cron or manually
dispatch the router sweep.

## Amendment (2026-07, PR #1227): source-PR binding + per-phase head recheck

Review of the original bridge surfaced two real gaps, both hardened here:

- **`workflow_run.pull_requests` is association, not provenance, and parked
  runs never evaluate `run-name`.** GitHub
  documents that array as open PRs whose head SHA or head branch matches the
  run and warns they did not necessarily trigger it. If the reviewed PR's head
  moved (so it no longer matched the run head SHA) while an unrelated PR still
  sat on the run head SHA, the old "exactly one associated PR" selection could
  dispatch recovery onto that unrelated PR. Production run `29555271824`
  proved a second constraint: GitHub parks Copilot review runs before evaluating
  workflow YAML, so its `display_title` remained the native PR title and the
  encoded `run-name` design could never bind a parked wake. Fix: the bridge now
  treats associations only as a bounded candidate set and selects one PR from
  trusted REST review/comment records carrying Copilot's immutable ID, the run
  head commit, and a creation/submission time within 30 seconds before run
  creation. Matching evidence on zero or multiple PRs fails closed; multiple
  records on one PR collapse to that one target. The selected live PR must still
  match the run head SHA and exact `run.head_branch`. Edited or dismissed events
  without fresh immutable evidence use the exact operator fallback.
- **The `expected_head_sha` fence was checked only once.** Reconcile validated
  the head at its opening PR fetch, but several read phases run before the first
  write, so a synchronize could still move the head before a state comment,
  label, recovery task comment, or Copilot assignment mutated it (only
  `enablePullRequestAutoMerge` carried an `expectedHeadOid`). Fix:
  `reconcile.mjs` now re-fetches the live head and compares it immediately
  before every mutation phase (`reason=head-sha-moved-before-mutation
phase=<phase>`), failing closed with no mutation on a mismatch. An empty
  `expected_head_sha` remains a no-op with no extra API calls.
- **Protected-file evidence followed the mutable PR head.** The original
  `/pulls/{number}/files` check could observe a different commit if the PR moved
  after `getPull()`, enabling an A→B→A race where the validated run head and the
  file evidence did not match. Fix: the bridge now compares every protected
  recovery workflow's Git blob at immutable `run.head_sha` against the
  default-branch blob and never consults mutable PR-file evidence. Changed or
  missing definitions fail closed as `protected-workflow-modified`. Base and
  head branch refs are also compared exactly (trim-only), preserving Git's
  case-sensitive branch identity.
- **Default-tip blob equality rejected legitimate stale branches.** Comparing
  `run.head_sha` to today's default branch treated trusted workflow additions or
  edits made only on `main` as if the PR authored them. Fix: the bridge obtains
  the immutable merge base of the default branch and run head, then compares the
  exact 12-file privileged boundary: four workflow sinks, the three recovery
  entrypoints, and their five transitive policy/API modules. Equal old blobs and
  files absent at both points pass; branch additions, modifications, deletions,
  and renames fail closed. A deterministic import-closure test prevents new
  privileged relative imports—including static, side-effect, and literal
  dynamic imports—from escaping the boundary without locking unrelated scripts.
  Missing merge-base evidence also fails closed. The mutable/truncated compare
  `files` list is never trusted.
- **A manual bridge rerun could repeat the write.** Rerunning the bridge retains
  its original trusted `workflow_run` payload, so provenance alone cannot
  distinguish the replay. The dispatch job now requires
  `github.run_attempt == 1`; later attempts remain read-only inspection runs.
- **Conflict recovery lost the metadata fence across nested dispatch.** Reconcile
  now rechecks trusted metadata immediately before dispatching
  `auto-rebase-prs.yml`, and the targeted conflict/failure callbacks propagate
  the paired expected head/base values back into `ci-recovery.yml`. Legacy broad
  rebase sweeps retain their prior unbound behavior.
- **Same-head metadata changes escaped the SHA fence.** A PR can be retargeted
  or closed without changing its head, so SHA-only rechecks could mutate a PR
  whose live metadata no longer satisfied the bridge policy. Fix: the bridge
  now passes `expected_base_ref`, and reconcile mirrors the validated state,
  draft status, base ref, base repository, head repository, and head SHA both at
  startup and immediately before each mutation. Same-head retarget and
  draft-conversion races fail closed with zero mutations; empty expected inputs
  preserve normal recovery behavior.
- **An interrupted ownership acquire could strand the invariant.** Label
  creation/attachment occurs before the state comment write. If a metadata
  recheck exited between them, the next run saw an owner-label artifact with no
  active state and threw forever. Reconcile now detects either one-sided label
  artifact after the opening trust fence and converges it through the existing
  guarded idempotent release path before asserting ownership consistency. Every
  later release decision reads the live in-memory PR label state rather than the
  opening snapshot, preventing duplicate ownership deletion during closed,
  admission-wait, and converged paths.

Residual risk: GitHub offers no atomic conditional metadata mutation, so the
per-phase recheck narrows but cannot fully close the sub-second window between a
recheck and its immediately following write. It is further fenced by
`expected_head_sha` and the auto-merge `expectedHeadOid`, and is documented
rather than claimed eliminated.

Validation (this amendment): the full CI-recovery policy/router/state suite
reported 168 tests (126 passed, 42 known Windows subprocess-shutdown skips,
0 failed); workflow wiring reported 8/8 passed; typecheck, `verify:fast`,
PR prerequisites, and review-ledger validation passed. A focused independent
review of the nested dispatch fence found one incomplete happy-path fixture; it
was corrected, and the second review round was clean.
