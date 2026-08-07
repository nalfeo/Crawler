# Session Handoff: Comment baseline win-rate on the released PR

## Date

2026-07-06

## Persona

Producer

## Systems touched

ci-policy

## Apples

2🍎 estimated, 2🍎 actual (🎯 exact) — single-file CI step + job-level permissions
change, with a non-trivial correctness surface (commit→PR discovery, node
body-building guards, best-effort control flow) that warranted a plan review.

## What Was Done

Added a `Comment baseline win-rate on released PR` step to the `baseline-sweep`
job in `.github/workflows/deploy.yml` (the job that runs the 100-seed Floor-1
win-rate sweep after each Pages deploy — added by PR #791). After the sweep
publishes its baseline to the orphan `baselines` branch, the new step resolves
the PR whose squash-merge produced the released commit
(`gh api repos/…/commits/$SHA/pulls --jq '.[0].number // empty'`) and posts a
comment like `📊 Baseline win-rate for this release: **79%** (237/300)` with
links to the sweep run and the recorded `by-sha/<sha>.json` baseline.

- **Permissions:** a job-level `permissions:` block replaces the workflow default
  entirely, so `pull-requests: write` is NOT inherited. Added both
  `pull-requests: write` **and** `issues: write` (kept `contents: write`) —
  `gh pr comment` posts via the issue-comments API, and the proven deploy-job
  comment step ran with both scopes, so this de-risks the one plausible 403.
- **Best-effort by design:** distinguishes a real `gh api` failure (`::warning::`)
  from a commit with genuinely no associated PR (`::notice::`); guards a
  missing/unreadable `baseline.json` and out-of-range win-rate fields; warns
  (never fails) on comment error; `continue-on-error: true` is a final backstop.
- **Placement:** runs last, after the guaranteed diagnostic `Upload baseline as
artifact` step, so a stalled network call can never delay that upload.

Runtime/real-artifact observation (rule #10 — this is CI/release-workflow logic,
first live run is post-merge): validated pre-merge by local dry-run against the
**real** released SHA `b4fcf201…`/PR #791 — `gh api …/commits/<sha>/pulls`
returns `791`; a verbatim copy of the embedded node body-builder run against the
real `by-sha/b4fcf201….json` renders `📊 … **79%** (237/300)` + both links; and a
`bash -eo pipefail` harness with a mocked `gh` exercised all five paths (happy
post, no-PR notice, api-failure warn, body-build-failure warn, comment-failure
warn) — every non-happy path exits 0. Plus Prettier `--check`, `js-yaml` parse
(new step present + `permissions={contents,pull-requests,issues:write}`), and
`npm run verify`. The step itself only executes on the next Pages deploy from
`main` (or an admin-gated `workflow_dispatch`).

## Key Decisions Made

- Grant `issues: write` in addition to `pull-requests: write` on the
  `baseline-sweep` job (proven-config choice to avoid an ambiguous 403 for
  `gh pr comment`); the workflow default and the deploy job are untouched, so the
  least-privilege intent (scoped to the deploy job) is preserved.
- Order the comment step after the artifact upload so the diagnostic artifact is
  never blocked by a networked, best-effort step.
- Skip idempotency for v1 (post once per run) per the ask — do not over-engineer.

## What's Next / Blockers

- No follow-up required. The first live exercise is the next natural Pages
  release from `main` (its `baseline-sweep` will comment on the triggering PR).
- Optional future work: a light idempotency guard (skip if an identical baseline
  comment already exists) if re-runs double-posting ever becomes noise.

## Retrospective

### Lessons Learned

- A job-level `permissions:` block in a GitHub Actions workflow **overrides** the
  workflow default entirely — scopes are not merged/inherited. Any scope the job
  needs must be listed on the job, even if the workflow default already grants it.
- `gh pr comment` posts through the issue-comments API; when the token is the
  restricted `GITHUB_TOKEN`, granting both `pull-requests: write` and
  `issues: write` is the safe way to avoid a 403 on PR comments.
- Under `bash -eo pipefail`, `VAR=$(cmd) || { … }` correctly catches `cmd`'s
  non-zero exit (no `local`-masking when not inside a function), which makes the
  best-effort skip pattern reliable.

### Mistakes Made

- Created `plan.md` at the repo root first (policy: planning markdown belongs in
  the session folder, not the repo) and had to relocate it. Early signal: the
  session context explicitly names the session-folder `plan.md` path — write
  there from the start so it never risks being committed.

### Opportunities for Future Improvement

- The deploy job's `Label and comment on released PRs` step and this new step
  both build PR comments with near-identical `gh`/`::warning::` scaffolding; a
  shared `scripts/agent/pr-comment.mjs` helper could DRY the body-building and
  best-effort posting if a third such step ever appears.
