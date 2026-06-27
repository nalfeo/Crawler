# CI Policy

## Core Principles

- All CI gates are deterministic. No LLM-as-judge checks are allowed.
- Gates are ordered by speed so failures happen as early and cheaply as possible.
- Every blocking gate must fail with a clear, actionable error message.

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

## Non-Negotiable

No CI step may call an LLM service, use subjective grading, or depend on non-deterministic runtime behavior.
