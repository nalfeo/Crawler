# Benchmark and sweep result discovery policy

Date: 2026-08-12

## Persona

DevOps Engineer

## Systems touched

ci-policy, ai-combat-balance

## Apples

1🍎 estimated, 1🍎 actual (exact).

## What changed

- Added the canonical prior benchmark and sweep result discovery order to
  `docs/agent-os/policies/ci-policy.md`.
- Agents now inventory branches with `git branch --all`, inspect recent history
  on candidate branches, and search committed branch trees and artifacts before
  querying GitHub Actions workflow history.
- The policy gives an active or explicitly named benchmark branch priority and
  requires reporting the branch and commit when repository evidence supplies
  the result.
- Repaired three stale references to archived handoffs in the review-harness
  policy and ADRs found by `npm run docs:check`.

## Reason

A workflow-history-first lookup incorrectly treated a current benchmark branch
as unavailable. Repository branches and committed benchmark artifacts are now
the required primary evidence sources; Actions is the fallback.

## Validation

- `npm run docs:check`
- `npm run verify:fast`
