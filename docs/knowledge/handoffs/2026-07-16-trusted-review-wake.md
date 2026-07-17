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
- When GitHub omits `workflow_run.pull_requests`, the bridge queries commit
  associations, filters every candidate through the same policy, and requires
  exactly one eligible survivor.
- PRs that modify or rename the router, bridge, or recovery workflows are
  rejected. The accepted path emits one PR number and the write-only job makes
  one targeted `ci-recovery.yml` reconciliation dispatch; it never invokes the
  router or a sweep.
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
  (15/15)
- `npx vitest run --project unit
tests/unit/ci-recovery-review-wake-bridge.test.ts` (3/3)
- `npm run verify:fast`
- Review harness: separate-model plan review produced three resolved concerns
  (`plan_divergence=minor`); code-review round 1 produced two resolved concerns,
  and round 2 was clean.

## GitHub platform caveat

GitHub registers `workflow_run` listeners only from the default branch, so this
feature branch cannot produce the final live delivery proof. After merge, the
first Copilot-authored parked router review run must create one bridge run and
one targeted CI Recovery run. If GitHub does not emit that `workflow_run`
event, use the documented targeted `gh workflow run ci-recovery.yml` fallback;
do not wait for cron or manually dispatch the router sweep.
