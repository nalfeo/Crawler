# CI Policy

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

## Canonical Gate Stack

Run the gate stack in this order:

1. **Typecheck** — `npm run typecheck`
2. **Lint** — `npm run lint`
3. **Format check** — `npm run format:check`
4. **Conventional commit / semantic PR title check** — enforce approved change prefixes and semantic pull request titles
5. **Dead code detection** — `npm run lint:dead-code`
6. **Lab gate check** — `bash scripts/agent/lab-gate-check.sh`
7. **Unit tests** — `npx vitest run --project unit --reporter=verbose`
8. **Property and determinism tests** — run invariant-focused suites in `tests/property/` and `tests/determinism/`
9. **Integration tests** — `npx vitest run --project integration --reporter=verbose`
10. **Headless Governor / e2e smoke** — `npx vitest run --project e2e`
11. **Coverage thresholds** — `npm run test:coverage`
12. **Production build** — `npm run build`
13. **Dependency audit** — `npm audit --audit-level=high`

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

## Conventional Commit Enforcement

Allowed change types are:

- `feat:`
- `fix:`
- `chore:`
- `lab:`
- `docs:`
- `refactor:`
- `test:`
- `perf:`
- `ci:`
- `build:`
- `revert:`

This list is enforced by `commitlint.config.cjs` (the canonical source — keep the two in sync). Pull requests must also use a semantic title that matches the same intent family.

## Branch Protection Rules

Protect `main` with the following rules:

- Require all blocking CI checks to pass before merge
- Require the semantic PR / commit check to pass
- Require the branch to be up to date with `main` before merging
- **No human review requirement** — merges are approved by passing CI only
- Block force-pushes and branch deletion on `main`
- Prefer squash merge or other linear-history-friendly merge settings

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
  `docs/knowledge/handoffs/2026-06-23-revert-swarm-kite-regression.md` handoff.
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

- **Assigning `@copilot` from a workflow needs a GitHub App token.** The
  default `GITHUB_TOKEN` (identity `github-actions[bot]`) is silently
  ignored when assigning `@copilot` — no error, no annotation, the Copilot
  coding agent simply does not trigger. Use `actions/create-github-app-token@v1`
  with repo secrets `APP_ID` + `APP_PRIVATE_KEY` to mint a real App token
  for these steps. Affects `coverage-gap-copilot.yml`,
  `copilot-review-ping.yml`, and `nightly-mutation.yml`.

<!-- Source handoff: 2026-06-22-gh-app-token-copilot-assign.md -->

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

<!-- Source handoff: 2026-06-25-pr-guard-concurrency.md -->

## Non-Negotiable

No CI step may call an LLM service, use subjective grading, or depend on non-deterministic runtime behavior.
