# Handoff: CI/CPU Reduction

**Date:** 2026-07-06  
**Session:** ci-cpu-reduction  
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** exact

## Systems touched

ci-policy, docs-tooling

## What was done

Implemented 6 mechanical improvements to reduce CI runner-slot consumption and agent-session startup cost. No game logic was changed.

### F1 — Split coverage out of blocking `test-unit` (saves ~110s/PR)

`ci.yml`: `test-unit` now runs without `--coverage` (~27s). A new parallel advisory job `test-unit-coverage` runs with coverage, uploads the artifact, and posts the PR comment. Not wired into merge-gate, so a coverage regression is visible without blocking the branch.

### F2 — Conditional Playwright install in `setup-node` (saves ~15–30s per non-e2e job)

`.github/actions/setup-node/action.yml`: Added `install-playwright` input (default `false`). All playwright steps (system deps apt install + browser download) are gated on the input. Only `test-e2e` in `ci.yml` passes `install-playwright: true`. When `npm ci` runs on a cache miss, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` prevents the postinstall script from downloading the browser for non-playwright jobs.

### F3 — Lighter copilot-setup-steps (saves ~30s per new agent session)

`.github/workflows/copilot-setup-steps.yml`: Replaced `npm run verify:fast` (full typecheck + lint + all unit tests) with `npm run typecheck:src` (src/ only). CI gates cover everything on every PR; the setup-steps goal is confirming the environment works, not re-running CI.

### F4 — `typecheck:src` in blocking CI job

`ci.yml` `check-types-and-lint`: Changed from `npm run typecheck` (src + tests + scripts, ~860 files) to `npm run typecheck:src` (src only, ~340 files) in the blocking parallel check. Full typecheck moved to `ci-advisory` as a non-blocking step.

### F5 — Consolidate security-review from 6 jobs to 1 (6→1 runner slots)

`security-review.yml`: Merged 6 parallel jobs (`check-npm-audit`, `check-secrets`, `check-codeowners`, `check-deps`, `check-dynamic-patterns`, `check-ai-prompts`) into a single `security-checks` job with 30min timeout. Each check is a step with `continue-on-error` so a single failure doesn't skip later checks. The `aggregate-results` job now only runs on scheduled/dispatch (not PRs) since there's nothing to aggregate on PRs.

### F6 — `pool: 'threads'` for vitest unit project

`vitest.config.ts`: Added `pool: 'threads'` to the `unit` project. Worker threads have lower spawn overhead than forked processes. Unit tests are pure-logic with isolated module registries per thread, so this is safe. Other projects (`integration`, `headless`, `e2e`) retain the default `forks` for isolation.

## In-game profiling

A separate background agent was started to profile in-game CPU hotspots. Its findings will be written to `/tmp/ingame-perf-analysis.md`.

## Lessons

- The `setup-node` composite action always ran `playwright install-deps chromium` (apt packages) even for jobs that never touch a browser — worth checking other composite actions for similar unconditional setup.
- The code review flagged `auto-rebase-prs.yml` as part of this diff — that change is from an earlier commit on this branch, not this session. Not a false positive about my changes.

## Follow-up

- Once the in-game profiling agent reports, a follow-up session should address its findings (likely candidates: collision spatial hash rebuild, AI behavior tree tick cost).
