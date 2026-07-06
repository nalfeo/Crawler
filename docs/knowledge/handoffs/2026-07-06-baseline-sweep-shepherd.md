# Session Handoff: Shepherd baseline-sweep PR #791 to merge

## Date

2026-07-06

## Persona

Producer (PR Shepherd) — took over an archived cloud-session PR.

## Systems touched

ci-policy, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (exact) — CI/release workflow logic + non-trivial
concurrency-safe bash + apple-scaled review harness.

## What Was Done

Drove PR #791 (`ci: capture 100-seed baseline sweep after each Pages release`)
to a clean squash-merge. The PR adds a `baseline-sweep` job to `deploy.yml` that
runs a 100-seed Floor-1 win-rate sweep after each Pages deploy and stores the
result on a persistent orphan `baselines` branch (`by-sha/<sha>.json` +
`index.json`), plus a `find-baseline.mjs` resolver (`npm run perf:find-baseline`).

Sole CI blocker was `commit-lint`: it validates the PR **title** as the squash
subject, and `deploy:` is not an allowed conventional type. Retitled to `ci:`.

Rather than hand-wave the two open `copilot-pull-request-reviewer` threads, I
implemented proper fixes and ran the review harness:

- **Fix 1 (permissions, least-privilege):** reverted the workflow-level
  `permissions.contents` from `write` back to `read`. Only `baseline-sweep`
  pushes and it already carries a job-level `contents: write`; the `deploy` job
  never writes repo contents (Pages uses `pages: write` + `id-token: write`).
- **Fix 2 (concurrency-safe publish):** rewrote the "Publish to baselines
  branch" step. `index.json` is now **regenerated** from every `by-sha/*.json`
  (a pure derivation — concurrent jobs never textually merge the shared array);
  a `publish()` function builds the worktree from `origin/baselines` (`-B`
  reset) or an orphan on first run, and a bounded 5× jittered retry loop re-runs
  it against the latest remote tip. This resolves both the concurrent-index
  conflict and the first-run orphan race.
- **Plan-review follow-up:** `git ls-remote --exit-code` is now classified by
  exit code — orphan path only on rc=2 (branch absent); any other non-zero
  (network/auth, e.g. 128) returns 1 to retry instead of wrongly forking a
  second orphan history. Also documented the latest-baseline-per-commit
  semantic and improved `find-baseline`'s "no baseline found" message to advise
  a larger `--max-walk`.

Runtime/real-artifact observation: this is CI/release-workflow logic (no
game-runtime system added), validated by YAML parse (`jobs=deploy,baseline-sweep`,
workflow `contents: read`, `baseline-sweep.permissions={contents:write}`),
`node --check` on all embedded scripts + the resolver, a fixture run of the
index-regeneration script (correct newest-first-by-commitDate ordering matching
the resolver's data contract), Prettier, preflight, and `verify:fast` — all
green. The job itself only executes post-merge on the next Pages deploy from
`main`.

## Key Decisions Made

- Regenerate `index.json` from the by-sha files instead of appending, making the
  index a pure function of per-commit files → concurrency-free by construction.
- Keep `contents: write` job-scoped to `baseline-sweep`; workflow default stays
  `read` (least privilege).
- Classify `ls-remote` failures by exit code so a transient probe failure
  retries rather than taking the orphan path.
- Review harness at 3🍎: separate-model plan review (gpt-5.4) + code-review loop
  (claude-sonnet-4.6 broad pass, then gpt-5.4 confirming pass on the final
  delta), both clean. Ledger:
  `docs/knowledge/review-ledgers/2026-07-06-baseline-sweep-shepherd.review-ledger.json`.

## What's Next / Blockers

- No follow-up work. Once `ci` + `commit-lint` are green and both threads are
  resolved, auto-merge (`--auto --squash`) completes on its own.
- First Pages deploy from `main` after merge creates the orphan `baselines`
  branch and the first `by-sha` + `index.json`. A future session could add a
  smoke check that `perf:find-baseline` resolves against it.

## Retrospective

### Lessons Learned

- `commit-lint` validates the **PR title** (the squash subject), so a
  non-conventional title fails even when every commit body is conventional.
  Retitle via `gh pr edit`/`update_pull_request` and the check re-runs.
- `git ls-remote --exit-code` returns **2** for "no matching ref" vs other
  non-zero for real transport errors — worth distinguishing in retry logic.
- `set -e` is suppressed inside a function invoked as `fn && …`; explicit
  `|| return 1` on every fallible command keeps the function's return code
  trustworthy, and the tail command's status is the return value.
- `copilot-pull-request-reviewer` threads can't be resolved by the auto-resolve
  bot (App-can't-resolve-App), so the owner must `resolveReviewThread` them via
  GraphQL after replying `✅ Addressed`.

### Mistakes Made

- Initially estimated 2🍎 before seeing that both review threads warranted real
  code fixes (permissions + a full publish rewrite) plus a 3-tier harness;
  revised to 3🍎 early, before writing code. Signal for next time: a "just
  retitle" shepherd task that carries unresolved substantive review threads is
  rarely 1–2🍎.

### Opportunities for Future Improvement

- The index-regeneration step reparses every `by-sha/*.json` on each publish;
  fine for now, but if the branch grows to thousands of releases a periodic
  compaction or incremental index would keep publish O(1).
- Consider a tiny post-deploy integration test that asserts `index.json` shape
  matches what `find-baseline.mjs` expects, to catch a future schema drift.
