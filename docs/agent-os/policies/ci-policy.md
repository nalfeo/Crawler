# CI Policy

> **CI knobs reference**: [`docs/agent-os/policies/ci-config-knobs.md`](./ci-config-knobs.md) — canonical
> list of every runtime-tweakable CI variable, its default, valid range, effect, and interactions.
> All operationally-meaningful CI behavior is adjustable via repo Actions variables; no code change
> required during incidents.

## Core Principles

- All CI gates are deterministic. No LLM-as-judge checks are allowed.
- Gates are ordered by speed so failures happen as early and cheaply as possible.
- Every blocking gate must fail with a clear, actionable error message.

## Broad-Sweep Execution Policy

- Treat any sweep or batch evaluation with **more than 10 runs** as a **broad sweep**.
- Broad sweeps default to **GitHub infrastructure** (`workflow_dispatch`/CI runners), not local/session compute.
- Use local execution for sweeps only when:
  - it is a small smoke run (≤10 runs), or
  - a human explicitly requests local execution.
- For Floor 1 weapon balance broad sweeps, use `.github/workflows/weapon-sweep.yml`.
- For larger AI combo/pathing batch evaluations, use `.github/workflows/ai-sweep.yml`.

## Prior Benchmark and Sweep Result Discovery

When a user asks for a prior benchmark or sweep result, search repository evidence
before GitHub Actions. A result may live on an active benchmark branch or in a
committed artifact even when no matching workflow run exists or is retained.

Use this order:

1. **Inventory local and remote branches first** with `git branch --all` and
   `git ls-remote --heads origin`. In a shallow or single-branch checkout, unrelated
   remote heads are absent from `git branch --all`. Identify any branch whose name
   or current checkout indicates the requested benchmark or sweep, then fetch each
   matching remote head with
   `git fetch --depth=<count> origin refs/heads/<branch>:refs/remotes/origin/<branch>`
   before inspecting it. Give an explicitly named or active benchmark branch
   priority over `main` and workflow history.
2. **Inspect recent history on candidate branches** with
   `git log --oneline --decorate -n <count> <branch>`. Use commit messages and
   changed paths to identify the commit that produced or recorded the result.
3. **Search each candidate branch tree for committed evidence** with
   `git ls-tree -r --name-only <branch>` and `git grep` (or `git show`) scoped to
   benchmark names, run IDs, and expected artifact paths. Check committed result
   files and summaries, including the canonical `artifacts/experiments/`
   directory, before treating a result as unavailable.
4. **Only then inspect GitHub Actions workflow history and downloadable
   artifacts.** Use Actions as a fallback for runs not represented in repository
   branches or committed artifacts, not as the first source of prior results.

Report which source produced the result, including the branch and commit when it
came from repository evidence. Do not imply that an Actions-history miss means the
benchmark did not run until the branch and artifact search is complete.

## Canonical Gate Stack

Run the gate stack in this order:

1. **Typecheck** — `npm run typecheck`
2. **Lint** — `npm run lint`
3. **Format check** — `npm run format:check`
4. **Dead code detection** — `npm run lint:dead-code`
5. **Lab gate check** — `bash scripts/agent/lab-gate-check.sh`
6. **Unit tests** — `npx vitest run --project unit --reporter=verbose`
7. **Property and determinism tests** — run invariant-focused suites in `tests/property/` and `tests/determinism/`
8. **Integration tests** — `npx vitest run --project integration --reporter=verbose`
9. **Headless Governor / e2e smoke** — `npx vitest run --project e2e`
10. **Coverage thresholds** — `npm run test:coverage`
11. **Production build** — `npm run build`
12. **Dependency audit** — `npm run security:audit`

## Coverage Thresholds

Minimum line-coverage **targets** by layer (the bar this project is steering toward):

- `src/core/`: 90%
- `src/game/`: 90%
- `src/shared/`: 90%
- `src/engine/`: 50%
- `src/labs/`: 30%
- Overall project: 80%

**Current mechanical enforcement:** `vitest.config.ts` enforces a set of
**per-file** coverage thresholds (see its `coverage.thresholds` block), not the
per-directory aggregates listed above. The per-directory numbers are the agreed
targets; as coverage rises, the next CI upgrade should ratchet deterministic
enforcement toward them rather than lowering the target.

## Branch Protection Rules

Protect `main` with the following rules:

- Require all blocking CI checks to pass before merge
- Require current PR-head evidence; base-only movement does not expire a green
  head when the repository-managed train is enabled
- **No human review requirement** — merges are approved by passing CI only
- Block force-pushes and branch deletion on `main`
- Prefer squash merge or other linear-history-friendly merge settings

When `MERGE_TRAIN_ENABLED=true`, the repository-managed train supersedes ordinary
squash auto-merge:

- Require the `merge-train` check so no ordinary/manual path can bypass the
  train.
- CI recovery adds clean same-repository PRs to the train instead of arming
  auto-merge.
- Only the repository App may bypass protection, and only to fast-forward
  `main` to the exact validated candidate SHA.
- Candidate validation runs the complete `verify:fast` gate set plus the targeted
  security suite as parallel, deterministic jobs. Unit and sprite projects are
  sharded without affected-only filtering; the full functional suite runs hourly
  on `main`.
- The reconciler repairs only the six oldest non-ready PRs. A train-detected
  conflict returns the affected PR for a conflict-only rebase and fresh head
  validation.
- See
  [`docs/guides/merge-train.md`](../../guides/merge-train.md) and ADR
  [`0060-repository-managed-speculative-merge-train`](../../knowledge/adr/0060-repository-managed-speculative-merge-train.md).

## Looping Automation Workflows

In addition to the per-PR `ci.yml` gate stack, three scheduled workflows run
deterministic, self-driving health checks:

| Workflow                                | Cadence                | Purpose                                                                 |
| --------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `.github/workflows/docs-update.yml`     | Weekly (Mon 09:00 UTC) | Path/ADR consistency, handoff archive, command sync                     |
| `.github/workflows/security-review.yml` | Daily 06:00 UTC + PR   | `npm audit`, secret scan, CODEOWNERS, dep allowlist, prompt-injection   |
| `.github/workflows/test-health.yml`     | Weekly (Mon 09:30 UTC) | Coverage trend, untested systems, extended property, balance regression |

Rules for these loops:

- Every check is a script with an exit code under `scripts/agent/{docs,security,health}/`.
- Side-effects (handoff archive, metrics file updates) ship as auto-PRs, never
  as direct pushes to `main`.
- Findings are aggregated into a single tracking issue per scheduled run via
  `scripts/agent/shared/aggregate-report.ts`.
- `security-review.yml` is a **required check on PRs** (hard fail). On scheduled
  runs it files an issue instead so the loop never silently swallows a finding.

See ADR `docs/knowledge/adr/0007-automation-loops.md` for rationale.

## Agent Responsibility for Failures

Agents must fix every test, lint, typecheck, or build failure they encounter — no exceptions for "preexisting" or "unrelated" failures.

- **Do not document failures and move on.** The practice of running the suite before starting just to record a baseline of failures to ignore is waste; it produces cruft that compounds across sessions.
- **Do not skip or comment out failing tests** to make CI green. Fix the underlying issue.
- If a failure is genuinely caused by an in-progress external change (e.g. a dependency that hasn't landed yet), pause and flag it to the user; do not silently bypass it.
- The only acceptable state for a PR to merge is: all CI gates green on real passing code.

## Incremental Change Discipline

When changing **behavior** in a system covered by the headless gate — AI, combat,
pathfinding, or floor progression — make **one behavioral change per commit** and
re-run `npm run test:headless` after each.

- **One behavioral change per commit.** Do not batch multiple behavioral changes
  into a single commit. Batching makes a regression un-bisectable and forces a
  full revert of everything instead of reverting just the offending change. The
  cautionary example is the swarm-kite revert (commit `28bfac4`, which shipped
  swarm-separation kite + melee focus-dive + ranged line-of-sight reposition in
  one commit): it broke the headless gate on correctness, performance, **and**
  stability simultaneously and had to be reverted wholesale — see the
  `docs/knowledge/handoffs/archive/2026-06-23-revert-swarm-kite-regression.md` handoff.
- **Expect an over-broad change to fail several assertions at once.** The headless
  gate (`tests/headless/floor1-completion.test.ts`) asserts correctness on
  deterministic _game_ time **and** a coarse wall-time perf-regression guard
  across the full seed × weapon matrix, so a change that touches too much tends to
  trip multiple assertions together. Isolate changes so the one that failed is
  obvious.
- **Keep it deterministic.** This is a process discipline, not a new gate — no
  LLM-as-judge, no subjective grading. The headless gate stays a script with an
  exit code.

### Diagnosing headless wall-time flakes on unrelated PRs

Before treating a headless wall-time miss as a regression on your PR, check
whether the underlying behavior actually changed:

- If **frame counts are identical across runs** and only wall-time differs,
  the run hit environmental CPU contention (shared runner, noisy neighbor).
  Rerun on a less-contended host. This is not your bug.
- Real regressions are **stable and deterministic** across re-runs — same
  seed, same frame count, wall-time consistently over budget.
- **Do NOT raise `HEADLESS_WALL_TIME_BUDGET_MS` to make it green.** The
  budget is calibrated (`docs/systems/ai-pathfinding.md`); raising it hides
  the next real slowdown.

<!-- Source handoff: 2026-06-26-pr2b-2-7-stage-workflow.md -->

## GitHub Automation Gotchas

Some GitHub features silently ignore the default workflow token, which
produces workflows that "run green" but do nothing.

- **Assigning the Copilot coding agent from a workflow needs a user PAT.** The
  default `GITHUB_TOKEN` is silently ignored, and GitHub explicitly rejects
  GitHub App installation tokens for agent assignment. Trusted default-branch
  recovery workflows use the repository-scoped `CRAWLER_CI_PAT` and GraphQL
  `replaceActorsForAssignable`; the PAT is never exposed to a PR checkout.
- **Never approve a fork workflow run automatically.** Recovery approval is
  limited to same-repository, non-draft PRs.

<!-- Source handoff: 2026-06-22-gh-app-token-copilot-assign.md -->

## Unified CI Recovery

- `.github/workflows/ci-recovery-router.yml` reacts to PR, review, and CI events
  and runs every 10 minutes as a backstop.
- `.github/workflows/ci-recovery.yml` is the only PAT-bearing PR reconciler. It
  executes trusted default-branch code and never checks out PR code.
- Shared per-PR concurrency uses `queue: max`, so event bursts drain FIFO instead
  of replacing a pending reconciliation.
- `ci-owner-pr-N` is an atomic ownership bit; one paginated
  `<!-- crawler-ci-state:v1 -->` comment stores full state. Missing, duplicate,
  or inconsistent state fails closed.
- A task fingerprint hashes the latest head SHA and complete normalized blocker
  set. The same fingerprint is never dispatched twice.
- Recovery treats missing policy artifacts as ordinary fix work. If a review
  thread or guard output says a PR is missing an ADR, review ledger, apple record,
  handoff, or ledger evidence, the assigned agent should create or repair that
  artifact from PR/review context and validate it. It should escalate to a human
  only when the artifact requires a decision that is not inferable from the PR.
- Shepherd leases are acquired, heartbeated, and released through the same
  workflow. They become takeover-eligible after 30 minutes without activity,
  plus five minutes of queue-jitter grace.
- `CI_RECOVERY_MODE` defaults to `dry-run`; set it to `live` only after shadow
  output and a disposable-PR smoke test are clean.
- See ADR `docs/knowledge/adr/0058-github-native-ci-recovery-ownership.md`.

## Workflow Dispatch Permissions

- The workflow `permissions:` block controls **only the scope of
  `GITHUB_TOKEN`**, not which actors are allowed to click "Run workflow" on
  `workflow_dispatch`. A `403` on manual dispatch is fixed in
  `Settings → Collaborators → grant write access` on the repo, **not** by
  adding permissions in the YAML.
- Before removing a `continue-on-error: true` from a job, sample the **last
  40 CI runs** for that workflow via `gh run view --json jobs` and
  ground-truth against `step.conclusion` (not job status — job status can be
  masked by the very `continue-on-error` you're evaluating). 40/40 clean is
  the bar to graduate the step to a hard fail.

<!-- Source handoff: 2026-06-24-ci-infra-hygiene.md -->

## GitHub Actions Concurrency Patterns

- A **global** concurrency-group key (e.g. `group: my-guard`) evicts pending
  runs during force-push storms. Their conclusion is `CANCELLED`, and
  `gh pr checks` mislabels `CANCELLED` as `fail`, so the PR appears broken
  when it is just being rebased.
- Scope the concurrency group **per PR** instead:

  ```yaml
  concurrency:
    group: my-guard-${{ github.event.pull_request.number || github.ref }}
    cancel-in-progress: false
  ```

  Keep `cancel-in-progress: false` so an in-flight required check is not
  killed by the next push.

### Guard vs full-workflow cancel policy

The rule above (`cancel-in-progress: false`) applies to **guard** workflows —
lightweight per-check workflows where each run is a distinct required check and
canceling an in-flight run leaves the PR in a broken state.

**Full CI and Security Review workflows** (`.github/workflows/ci.yml`,
`.github/workflows/security-review.yml`) follow a different policy: they
explicitly set `cancel-in-progress: true` for `pull_request` events so that
stale builds triggered by superseded pushes are preempted. This is safe because
each new push triggers a fresh run and the old run's result is no longer
meaningful. Non-PR events (`push`, `schedule`, `workflow_dispatch`) use
`cancel-in-progress: false` via the same expression.

The concurrency group for these full workflows uses a hardcoded, immutable
workflow-specific prefix (e.g. `crawler-ci-`) rather than `github.workflow`
(the mutable display name) to guarantee group stability across renames and
prevent cross-workflow cancellation from display-name collisions:

```yaml
concurrency:
  group: >-
    crawler-ci-${{ github.event_name == 'pull_request'
      && format('pr-{0}', github.event.pull_request.number)
      || format('{0}-{1}-{2}', github.event_name, github.ref, github.run_id) }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

<!-- Source handoff: 2026-06-25-pr-guard-concurrency.md, 2026-07-19-ci-pr-cancel-policy.md -->

## Non-Negotiable

No CI step may call an LLM service, use subjective grading, or depend on non-deterministic runtime behavior.
