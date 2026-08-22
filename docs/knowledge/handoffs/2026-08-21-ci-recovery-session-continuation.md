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
  merge admission.
- Routed that blocker through the existing CI Recovery Copilot task/assignment
  path with a continuation protocol that preserves the incomplete status until
  the replacement agent has completed the work and the PR is ready for normal
  review.
- Added an end-to-end subprocess regression that verifies the task protocol,
  continuation phase, and Copilot assignment.
- Updated the canonical plan policy and its deterministic checker to preserve
  session-chat plans in the PR description or a PR comment.

## Evidence

- Targeted CI Recovery subprocess regression, formatting, fast verification, and
  docs checks passed.

## What's Next / Blockers

No local blockers. The published PR is ready for CI Recovery to validate.
