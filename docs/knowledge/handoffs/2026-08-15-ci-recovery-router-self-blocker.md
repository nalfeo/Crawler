# Session Handoff: CI recovery router's own failed job was an unclearable PR blocker

## Date

2026-08-15

## Persona

Producer → DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 exact (tooling/CI-only; no runtime gameplay change)

## What Was Done

Diagnosed and fixed the recovery-loop incident on PR #2952 (issue #2981). The
incident's only blocker was `ci-failure` id `route`, which `reconcile.mjs` builds
from a failed **check run on `pr.head.sha`** — and the only job named `route` in
the repo is the `route` job of `.github/workflows/ci-recovery-router.yml`, the
recovery pipeline's own dispatcher.

The classifier already excluded recovery's own checks via
`!checkName.includes('ci recovery')`. That matches `ci-recovery.yml` (whose job
carries `name: CI recovery for PR #…`) but not the router, whose `route` job had
no `name:` at all. So a failed router job became a PR blocker that nothing on the
branch can clear: recovery re-dispatched, made no progress, exhausted its retry
budget, and filed the loop incident. Exactly the defect class already handled for
`ci-failure copilot`.

Fix: identify recovery-owned checks by the **immutable workflow path**, not the
mutable display name.

- `state.mjs` gained `SELF_RECOVERY_WORKFLOW_PATHS`, `checkRunWorkflowRunId()`
  (parses the run id out of the Actions job URL that check runs already carry),
  `selfRecoveryWorkflowRunIds()` and `isSelfRecoveryCheckRun()`.
- `reconcile.mjs` moves the `/actions/runs?head_sha=` fetch above the check-run
  loop and filters self-owned checks there only; `checkRuns` is untouched for
  required-check/admission logic.
- The router `route` job now has `name: CI Recovery Router` (job id unchanged),
  so the retained name-substring fallback also covers it.

Observation (rule #9 equivalent for automation): the real artifact here is the
reconcile script, exercised end-to-end against a mock GitHub in
`reconcile.test.mjs`. Before the fix the new test fails with the PR being handed
a `route` blocker; after the fix the same PR reaches `would-arm-auto-merge` and
dispatches nobody. The failing-before state was verified by temporarily
restoring the old name filter, not assumed.

## Key Decisions Made

- **Path, not name, is identity.** Reused the precedent already documented on
  `AUTO_RETRIGGER_WORKFLOW_PATHS`: "Identity is the immutable workflow _path_,
  never the mutable display name." Hardcoding `checkName === 'route'` was
  rejected — brittle, collides with any future job named `route`, and does not
  generalize to other recovery-owned workflows.
- **Keep the name filter as a fallback, inside the helper.** The runs list is a
  single page; if the owning run is not in it (>100 runs on a head SHA) the name
  check still catches the reconcile job. Two independent mechanisms, one call
  site.
- **Narrowest blast radius.** The filter is applied only in the `ci-failure`
  blocker loop. Admission/required-check logic keeps the unfiltered `checkRuns`,
  so nothing about merge-gate semantics changes.

## What's Next / Blockers

The _reason_ the router job failed on run 31878782271 is still unknown — GitHub
API/log access was unavailable from this sandbox, so this session fixed the
propagation defect (a recovery-infrastructure fault masquerading as a PR
blocker), not whatever made the router red. A follow-up should read that job log.
The most suspicious candidate found by inspection is
`waitForDispatchedRunsVisible()` in `router.mjs`: it requires all `count` newly
dispatched runs to be simultaneously present in a _single_ outstanding-runs
snapshot. Dispatched runs are transient — an early one can complete before a
later one is queued — so with several dispatches the condition can never hold and
the 8-minute wait throws, failing the `route` job even though every dispatch
succeeded. Accumulating observed new run ids across polls would fix it. Not
changed here because it is a separate defect with no evidence tying it to this
incident.

## Retrospective

### Lessons Learned

- Recovery automation that classifies its own check runs as PR blockers creates a
  livelock, not a slowdown: the blocker is structurally unclearable, so every
  retry is guaranteed to make no progress. Any new automation workflow that can
  attach a check to a PR head SHA must be added to
  `SELF_RECOVERY_WORKFLOW_PATHS` at the same time.
- A job with no `name:` publishes its _job id_ as the check-run name. That is
  fine until something matches on names — then an unnamed job silently escapes
  every name-based filter. Worth remembering before writing any check-name rule.
- No `gh`/GitHub API token is available in this sandbox (`GH_TOKEN` unset,
  `api.github.com` blocked by the DNS proxy), and `web_fetch` of a private-repo
  run page returns a generic GitHub error. Root-causing a CI incident here has to
  come from the blocker _shape_ recorded in the issue plus the code that produces
  it — which was sufficient, because blocker kind/id/url uniquely identify the
  construction site in `reconcile.mjs`.

### Mistakes Made

- Ran `prettier --write` on the whole of `reconcile.mjs` and picked up two
  unrelated reformat hunks from pre-existing drift (that path is not covered by
  `format:check`). Caught on diff review and reverted by hand. Early signal:
  `git diff --stat` showing more changed lines than the edit justified — always
  read the full diff of a formatted file, not just the stat.
- A `str_replace` intended as an insertion point accidentally deleted the line
  following the anchor. Caught immediately by re-reading the diff. Early signal:
  an "insertion" whose `new_str` is shorter than its `old_str`.
- First instinct was to chase the router's runtime failure
  (`waitForDispatchedRunsVisible`) as the root cause, before noticing the blocker
  id `route` was itself the smoking gun. The incident's own blocker list was the
  faster evidence path and should have been read structurally first.

### Opportunities for Future Improvement

- Read the actual `route` job log and fix the underlying router failure (see
  What's Next). The snapshot-vs-accumulation issue in
  `waitForDispatchedRunsVisible` deserves its own session and regression test.
- Consider a deterministic lint that fails when any workflow under
  `.github/workflows/ci-recovery*` has a job whose check-run name is not
  self-identifying _and_ whose path is not in `SELF_RECOVERY_WORKFLOW_PATHS` —
  turning "remember to register new recovery workflows" into a gate.
- More generally, recovery could treat _any_ blocker whose owning workflow run is
  produced by repo automation (not by the PR's own CI) as non-actionable and
  escalate it as an infrastructure incident instead of a dispatch.
