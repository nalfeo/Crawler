# ADR 0007: Looping Automation Workflows

## Status

Accepted

## Date

2026-06-07

## Context

The bootstrap plan called for three continuous, self-driving health loops
beyond the PR-gated `ci.yml` stack:

- **docs-update** — periodic check that AGENTS.md / README / ADR / instruction
  files still match reality, plus mechanical hygiene (handoff archival,
  promotion candidates).
- **security-review** — daily and per-PR enforcement of dependency, secret,
  CODEOWNERS, dynamic-code, and AI prompt-injection hygiene.
- **test-health** — weekly coverage trend tracking, untested-system
  detection, extended (10x) property-based runs, and balance-regression
  comparison.

These were deferred in Phase 1 so the core CI gates could land first. With
those in place, we now want long-running loops that keep the project healthy
without requiring a human to remember to look.

## Decision

Add three GitHub Actions workflows under `.github/workflows/`:

| Workflow              | Cadence                          | Failure surface                                                     |
| --------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `docs-update.yml`     | Weekly + `workflow_dispatch`     | Tracking issue on findings; auto-PR for handoff archival            |
| `security-review.yml` | Daily + PR + `workflow_dispatch` | Hard-fail on PRs (required check); tracking issue on scheduled runs |
| `test-health.yml`     | Weekly + `workflow_dispatch`     | Tracking issue on findings; auto-PR for metrics file updates        |

Each check is a deterministic, exit-code-driven script under
`scripts/agent/{docs,security,health}/`. Per-script summaries are written to
JSON in `$AUTOMATION_REPORT_DIR` and merged into a single Markdown issue body
by `scripts/agent/shared/aggregate-report.ts`.

All scripts respect the **no-LLM-in-CI** contract from
[`ci-policy.md`](../../agent-os/policies/ci-policy.md). No external services
are called; everything runs in the runner with stdlib + already-installed
devDependencies (`tsx` for TypeScript scripts).

Side-effects (handoff archival, metrics file updates) ship as automated PRs
via `peter-evans/create-pull-request`, never as direct pushes to `main`. This
preserves branch protection and keeps a human-readable audit trail.

The loops live in **separate workflows** from `ci.yml` because:

1. They are slow (test-health alone takes ~10× a normal CI run).
2. They are non-blocking on PRs (except `security-review.yml`, which is
   intentionally part of required checks).
3. Their schedule should not block developer flow when GitHub Actions
   minutes are constrained.

## Consequences

### Positive

- Drift, regressions, and security hygiene issues surface continuously instead
  of when someone happens to notice.
- Each loop is debuggable locally via `npm run docs:check`, `npm run
security:check`, `npm run health:check`.
- The same scripts run in both contexts — no CI-only code paths.

### Negative

- More files to keep in sync when project structure changes (mitigated: the
  scripts themselves catch most drift).
- The `coverage-trend.json` and `balance-baseline.json` files churn over time
  via auto-PRs; reviewers must rubber-stamp them.

### Risks

- A noisy false-positive in one of the regex / heuristic checks could spam
  issues. Mitigation: each check emits findings at one of three severities —
  `info`/`skip` (silent), `warn` (visible, triggers issue), `error` (visible,
  triggers issue, fails PR runs for `security-review`). The aggregator
  surfaces every `warn` and `error` in the weekly tracking issue so the loop
  is honest about what it sees; severities can be tuned per script as we
  learn which checks are reliably high-signal.
- The `governor-playthroughs.ts` and `balance-regression.ts` scripts depend on
  a headless Governor harness that doesn't exist yet. They SKIP cleanly until
  the harness ships. Tracked as a follow-up.
- Branch-protection rules to make `security-review.yml` a required check on
  `main` must be configured in the GitHub UI by a repo admin.

## Alternatives Considered

- **LLM-judge for docs drift / balance.** Rejected per CI policy — non-
  deterministic, off-policy, and expensive.
- **One mega-workflow.** Rejected because the three loops have different
  cadences and failure semantics (PR-blocking vs informational).
- **Embedding loops inside `ci.yml`.** Rejected — would slow every PR by 5–10
  minutes for checks that only need to run weekly/daily.

## Follow-ups

- Wire up the headless Governor harness so
  `scripts/agent/health/governor-playthroughs.ts` produces real metrics.
- Add SpecKit drift detection once the SpecKit CLI exposes a scriptable diff.
- Integrate PackmindHub / context-evaluator once the tool is installed in the
  agent runtime.
- Have a repo admin add `security-review` to required-status-checks for
  `main`.
