# Session Handoff: Looping Automation Workflows (docs-update, security-review, test-health)

## Date

2026-06-07

## What Was Done

Implemented issue #1 — three scheduled GitHub Actions that continuously monitor
project health, following the strict "deterministic, scripted, exit-code-driven,
no LLM-as-judge" CI policy.

### New workflows

- `.github/workflows/docs-update.yml` — Mon 09:00 UTC, files an issue when docs
  drift; uses `peter-evans/create-pull-request` for handoff archive moves.
- `.github/workflows/security-review.yml` — daily 06:00 UTC + PR. PR runs fail
  hard (becomes a required check); scheduled runs file an `automation`/`security`
  issue.
- `.github/workflows/test-health.yml` — Mon 09:30 UTC, runs coverage, untested
  systems, extended property tests, governor playthroughs, balance regression.

### New scripts (`scripts/agent/`)

- `shared/report.ts` — `Report` class with severity-tagged findings, JSON
  summary writer, `finish(): never` for TS narrowing.
- `shared/aggregate-report.ts` — bundles per-script JSON into markdown body
  passed to `gh issue create --body-file`.
- `docs/check-paths.ts`, `docs/check-adr-consistency.ts`,
  `docs/archive-handoffs.ts` (dry-run by default, `--apply` flag),
  `docs/stale-game-design.ts`, `docs/check-readme-commands.ts`,
  `docs/promote-handoffs.ts`.
- `security/scan-secrets.sh`, `security/check-dynamic-patterns.sh`,
  `security/check-codeowners.ts`, `security/check-deps.ts` (allowlist),
  `security/check-ai-prompts.ts`.
- `health/coverage-trend.ts`, `health/untested-systems.ts`,
  `health/extended-property.ts`, `health/governor-playthroughs.ts` (SKIP —
  harness pending), `health/balance-regression.ts` (SKIP — baseline pending).

### Supporting changes

- `docs/knowledge/metrics/{coverage-trend.json,balance-baseline.json,README.md}`
  seeded.
- `docs/knowledge/handoffs/archive/.gitkeep` placeholder.
- `src/game/ai/README.md` stub — directory referenced in AGENTS.md and
  `game.instructions.md` but didn't exist; docs-update check correctly caught
  the drift, so I made the location real with a README explaining intent.
- `.gitattributes` — forces LF on `.sh` files (and most text files) so
  Windows checkouts don't introduce CRLF that breaks bash on CI.
- `CODEOWNERS` — added `/scripts/agent/` and `/docs/knowledge/metrics/`.
- `AGENTS.md` — extended Commands and Key Files tables.
- `package.json` — added `docs:check`, `security:check`, `health:check`
  npm script wrappers.
- `docs/agent-os/policies/ci-policy.md` — new "Looping Automation Workflows"
  section.
- `docs/knowledge/adr/0007-automation-loops.md` — ADR documenting why these
  loops live outside `ci.yml` and the "scripted, no LLM" contract.

## What's Next

1. **Follow-up issue filed** (see PR description): governor headless harness,
   SpecKit drift detection, PackmindHub integration, branch-protection wiring.
2. **First scheduled run will surface real findings** — already verified
   locally:
   - `untested-systems` reports 9 ECS systems without matching test files
     (`aoeOnImpact`, `areaDamage`, `deathTimer`, `knockback`, `lifetime`,
     `meleeSwing`, `playerInput`, `projectileCleanup`, `returningProjectile`).
     The loop is doing its job; these become follow-up test-coverage tickets.
   - `archive-handoffs` (dry-run) wants to move
     `2025-07-22-stats-skills-levels.md` (321 days old) — the first scheduled
     run will open a PR doing that move.
   - `check-adr-consistency` flagged ADR-0006 missing a `## Status` heading
     (it has `**Status**: Accepted` instead — warn only, not blocking).
3. **Untriaged backlog candidate**: the docs-update loop will likely add more
   tracking issues on first run; tag with `automation` and triage weekly.

## Blockers

None. Local WSL has a worktree git-path quirk where
`git rev-parse --show-toplevel` mangles the path, but CI Linux runners use a
plain checkout so the shell scripts execute correctly there.

## Branch State

- Branch: `nalfeo/automation-loops`
- All tests passing: yes (`npm run verify:fast` → 791 passed)
- PR created: yes (see PR linked from this branch)

## Test Results

```
Test Files  80 passed (80)
     Tests  791 passed (791)
  Duration  8.62s
✅ Fast verification passed.
```

All new scripts run end-to-end against current repo state with the expected
outcomes (clean, SKIP, or real findings as listed above).

## Key Decisions Made

- **Scripted-only, no LLM-as-judge** — matches `ci-policy.md`. Each check is a
  small `tsx`/bash script with exit code; aggregator bundles results into a
  single markdown issue body via `gh issue create --body-file`.
- **`Report` shared module** — keeps script output structurally identical so
  the aggregator can rely on `findings[]` and severity values without parsing
  ad-hoc text.
- **Side-effects via PRs, not direct commits** — `peter-evans/create-pull-request`
  for handoff archive moves and metrics-trend updates. Keeps automation
  reviewable.
- **Security review hard-fails on PRs, soft-reports on schedule** — best of both
  worlds: blocks risky merges, doesn't spam the team with failed workflow runs
  for findings that just need triage.
- **`src/game/ai/` made real** — the docs-update check correctly identified
  doc drift; adding a stub README was simpler and more honest than
  allowlisting the path.
- **`.gitattributes` added** — repo previously had no line-ending policy;
  Windows checkouts of shell scripts broke bash. Forcing LF is a one-time fix
  that benefits everyone.
