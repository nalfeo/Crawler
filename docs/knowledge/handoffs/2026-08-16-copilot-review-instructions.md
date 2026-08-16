# Copilot review instructions and nightly process check

## Date

2026-08-16

## Persona

DevOps Engineer

## Systems touched

ci-policy, docs-tooling, agent-personas

## Apples

2🍎 estimated, 2🍎 actual.

## What changed

- Expanded `.github/instructions/review.instructions.md` so native GitHub
  Copilot PR review stays scoped to changed files and directly touched systems
  rather than scanning the whole codebase.
- Grounded the review checklist in Crawler-specific game-development risks:
  deterministic simulation, runtime wiring, ECS/Phaser layer boundaries,
  gameplay correctness, performance hot paths, real-artifact observation, and
  regression coverage.
- Added a recurring-failure checklist drawn from recent Crawler regressions:
  lab-only success, silent reverts, aggregate-file collisions, defanged guards,
  fixture drift, automation deadlocks, runtime/test split-brain, asset integrity,
  sweep misuse, and performance-neutrality leaks.
- Added `scripts/agent/docs/review-process-check.ts`, a deterministic nightly
  checker that verifies the GitHub-facing Copilot instructions still route to
  the canonical review contract and that the contract retains the required
  high-yield review anchors.
- Added `.github/workflows/nightly-code-review-process.yml`, a nightly/manual
  workflow that runs the checker, aggregates automation reports, and files a
  superseded tracking issue only when the review-process anchors drift.

## Validation

- `bash scripts/agent/preflight.sh`
- `npx tsx scripts/agent/docs/review-process-check.ts`
- `npm run typecheck`

## Notes

- The nightly check is intentionally deterministic and does not introduce an
  LLM-as-judge CI gate. It evaluates process coverage by required instruction
  anchors and uses the existing automation report/issue pattern.
- No PR was opened by this session because the task did not explicitly request
  PR creation.
