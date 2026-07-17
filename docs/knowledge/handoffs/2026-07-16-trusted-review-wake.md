# Handoff: Trusted review-wake bridge

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated and actual — a new trusted workflow bridge and policy module with
deterministic policy/wiring coverage and a two-round review-harness loop.

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
- `node --test ".github/scripts/ci-recovery/review-wake-bridge.test.mjs"`
  (17/17)
- `npx vitest run --project unit
tests/unit/ci-recovery-review-wake-bridge.test.ts` (4/4)
- `npm run verify:fast`
- Review harness: separate-model plan review produced three resolved concerns
  (`plan_divergence=minor`); code-review round 1 produced two resolved concerns,
  and round 2 was clean.

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

- **`workflow_run.pull_requests` is association, not provenance.** GitHub
  documents that array as open PRs whose head SHA or head branch matches the
  run and warns they did not necessarily trigger it. If the reviewed PR's head
  moved (so it no longer matched the run head SHA) while an unrelated PR still
  sat on the run head SHA, the old "exactly one associated PR" selection could
  dispatch recovery onto that unrelated PR. Fix: `ci-recovery-router.yml` now
  sets a `run-name` that encodes the trusted `github.event.pull_request.number`
  for review/review-comment events (`CI Recovery Router: review-wake pr-<N>`),
  surfaced back as the run's `display_title`. Before parsing the title, the
  bridge requires the router workflow Git blob at the run head to exactly equal
  the default-branch blob (`router-workflow-untrusted` on mismatch), so
  PR-modified workflow code cannot forge the binding. It then evaluates only
  that source PR, cross-checking it against the association
  (`source-pr-not-associated`), the run head SHA, and `run.head_branch`
  (`head-branch-mismatch`). It fails closed on a missing binding
  (`missing-source-pr-binding`) or empty association (`no-associated-pr`). The
  workflow `name:` is unchanged so the existing `run.name` gate still matches.
- **The `expected_head_sha` fence was checked only once.** Reconcile validated
  the head at its opening PR fetch, but several read phases run before the first
  write, so a synchronize could still move the head before a state comment,
  label, recovery task comment, or Copilot assignment mutated it (only
  `enablePullRequestAutoMerge` carried an `expectedHeadOid`). Fix:
  `reconcile.mjs` now re-fetches the live head and compares it immediately
  before every mutation phase (`reason=head-sha-moved-before-mutation
phase=<phase>`), failing closed with no mutation on a mismatch. An empty
  `expected_head_sha` remains a no-op with no extra API calls.

Residual risk: GitHub offers no atomic conditional metadata mutation, so the
per-phase recheck narrows but cannot fully close the sub-second window between a
recheck and its immediately following write. It is further fenced by
`expected_head_sha` and the auto-merge `expectedHeadOid`, and is documented
rather than claimed eliminated.

Validation (this amendment): `node --test
".github/scripts/ci-recovery/review-wake-bridge.test.mjs"` (22/22) and
`reconcile.test.mjs` (added moved-head-before-mutation + empty-input coverage);
`npx vitest run --project unit tests/unit/ci-recovery-review-wake-bridge.test.ts
tests/unit/ci-recovery-router-run-name.test.ts` (7/7); `npm run typecheck`;
`npm run verify:fast`.
