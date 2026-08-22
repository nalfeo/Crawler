# Session Handoff: CI recovery session continuation

## Date

2026-08-21

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples (exact). The change adds one bounded recovery
classifier, its existing dispatch-path wiring, a subprocess regression, and the
canonical plan-preservation policy update.

## What Was Done

- Added a PR-description-only `Status:` line detector for `INCOMPLETE` plus
  `session ran out of time`, producing a `session-continuation` blocker before
  merge admission. Detection ignores non-rendered Markdown regions (HTML
  comments, fenced code blocks, indented code blocks) so templates and examples
  cannot act as control signals.
- Re-validated the body-derived signal immediately before the terminal dispatch
  and admission mutations, aborting (and releasing the ownership fence on the
  dispatch path) when the status changed mid-run.
- Routed that blocker through the existing CI Recovery Copilot task/assignment
  path with a continuation protocol that preserves the incomplete status until
  the replacement agent has completed the work and the PR is ready for normal
  review.
- Added an end-to-end subprocess regression that verifies the task protocol,
  continuation phase, and Copilot assignment, plus negative coverage for
  non-rendered Markdown regions and both mid-run status-change races.
- Updated the canonical plan policy and its deterministic checker to preserve
  session-chat plans in the PR description or a PR comment.

## Evidence

- Targeted CI Recovery subprocess regression, formatting, fast verification, and
  docs checks passed.

## What's Next / Blockers

No local blockers. The published PR is ready for CI Recovery to validate.
