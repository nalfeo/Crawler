# ADR 0035: Scope the Headless Gate, De-duplicate Local Verify, and Title-Only Commit-Lint

**Date:** 2026-07-02  
**Status:** Accepted  
**Affected Systems:** scripts/agent/verify.sh, scripts/agent/ci/detect-art-only.sh, .github/workflows/ci.yml, .github/workflows/commit-lint.yml, tests/unit

## Context

A guard/CI-infrastructure audit (sessions + PRs, 3-day window) found the same
tests were paid for **multiple times per change** with no added protection:

- **The Headless Floor 1 gate is the CI long-pole (~306s).** Local `npm run
  verify` re-ran the _entire_ CI suite — including that 306s headless replay and
  a production build — before **every** commit, on top of the authoritative CI
  run and again on every PR-shepherd re-push. Measured ~4.7 CI runs/branch at a
  93% pass rate: most reruns re-validate rather than catch bugs.
- **The headless gate ran on every code PR even when the diff provably can't
  change the deterministic sim.** `src/game/ai/headless-runner.ts` imports only
  `src/core`, `src/shared`, and `src/game/ai` (never `src/engine` — enforced by
  the ESLint layer rule), so engine/labs/e2e/docs/asset-only diffs cannot alter
  Floor-1 outcome.
- **`commit-lint` linted every commit in the PR range**, but PRs **squash-merge**,
  so intermediate commit subjects are discarded. It has BLOCKED merges over
  WIP/`codex:` subjects that never ship — pure friction under squash.

## Decision

Three surgical, protection-preserving changes:

1. **Local `verify.sh` defers only the headless gate** behind `VERIFY_FULL=1`
   (mirrors the existing `VERIFY_COVERAGE=1` opt-in). Typecheck, lint, format,
   guards, unit, **integration**, PR-prereqs, and **build** still run locally on
   every commit. Only the headless replay — authoritatively enforced by the
   REQUIRED CI `test-headless` job — is dropped from the default inner loop.
   Integration and build stay local because CI skips integration on `art_only`
   and only runs build on push-to-main, so they cover gaps CI leaves on PRs.

2. **Scope the CI Headless gate with a new `gameplay_safe` scope flag.**
   `detect-art-only.sh` now emits a third flag: `gameplay_safe=true` when every
   changed file is on an allowlist the headless runner can't import
   (`src/engine`, `src/labs`, `tests/e2e`, `docs`, `public`, `*.md`, `*.txt`).
   `ci.yml` skips `test-headless` when `gameplay_safe=true` **on pull_requests
   only** — `push`-to-`main` always runs it, preserving an observe-after-merge
   backstop if the allowlist is ever wrong. The merge-gate already treats a
   skipped headless as PASS (`allow_skipped=true`), so no merge-gate logic
   changes. Fail-safe unchanged: any ambiguity → all flags false → full suite.

3. **`commit-lint` validates the PR title, not the commit range.** The workflow
   lints `github.event.pull_request.title` (the actual squash-merge subject) via
   a new `commitlint.title.config.cjs` that reuses the base rules but sets
   `ignores: []`. The base `ignores` exist purely for commit-history artifacts
   (auto-merge `Title (#123)`, `merge:` metadata, exact historical subjects);
   applying them to a user-controlled title would let `bad title (#12)` bypass
   the gate.

## Consequences

### Positive

- Cuts ~306s (headless) off every local pre-commit run; the inner loop keeps all
  fast, deterministic protection.
- Skips the CI long-pole on rendering/docs/asset-only PRs that provably can't
  change the sim — the single biggest CI wall-time win — with zero loss of merge
  protection.
- `commit-lint` now gates the subject that actually lands on `main`, and stops
  blocking merges over squashed-away WIP messages. Closes the `(#n)` title
  bypass for user-controlled titles.
- New deterministic unit test (`tests/unit/detect-change-scope.test.ts`) drives
  the real bash classifier via a `SCOPE_FILES_OVERRIDE` hook, locking in the
  scope semantics (no LLM-as-judge; a misclassification that drops a gate fails
  the unit suite).

### Negative

- One more scope flag to reason about. Mitigated by the fail-safe default and the
  deterministic test enumerating every allowlist/deny case.
- Local `verify` no longer catches a headless regression pre-push; contributors
  touching `src/core`, `src/game/ai`, or balance must run `VERIFY_FULL=1 npm run
  verify` (documented in AGENTS.md and copilot-instructions.md). CI still blocks
  the merge regardless.
- Splitting commit-lint into a title config adds a second small config file.

## Out of Scope (explicitly deferred)

- **Guard removal / telemetry-driven pruning.** 8/11 guards have zero telemetry,
  but the telemetry pipeline is currently blind (guard `session.log()` output is
  not queryable and handoff adoption is ~8.5%). Removing guards on that basis
  would be guessing. Handled in a dedicated telemetry-repair session; the
  dead-guard analyzer stays deferred until coverage supports it.
- **Review-harness scope (plan review + code-review loop on ~95% of PRs).** This
  is the largest agent-time cost but changing it weakens a protection policy and
  needs explicit human sign-off (project rules #12/#14). Not touched here.
- **Automation-cron consolidation** (auto-rebase / auto-resolve / pr-ready
  reviewer noise). Noise-reduction only, no protection value — separate change.
