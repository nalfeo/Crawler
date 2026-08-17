# Floor 1 boss chest PR recovery

## Date

2026-08-17

## Persona

Producer coordinating Game AI Engineer, QA Engineer, and DevOps Engineer validation.

## Systems touched

ai-behavior-tree, boss-rooms, inventory, ci-policy

## Apples

3 apples estimated, 3 apples actual. The review fixes were already present, while
the remaining work was a mainline merge plus two focused CI expectation repairs.

## Summary

- Merged current `main` with a true two-parent merge commit.
- Independently validated both unresolved review threads against the current
  branch. Floor 1 now enables boss chests and equipment, both boss-defeat
  handlers spawn chests, and the safe-room maintenance planner advances the
  return router through `arrived` after claiming revealed chest rewards.
- Updated the stale Floor 1 exclusion integration test to assert the enabled
  chest lifecycle.
- Kept the historical baseball-bat seed 34 local-threat regression isolated
  from the new default settlement-return route. The same weapon/seed still dips
  below 70% health, recovers above 80%, wins within the official budget, and
  replays deterministically.

## Validation

- Boss chest integration test: 16/16 passed.
- Floor 1 local-threat headless regression: 1/1 passed.
- Floor 1 scenario, behavior-tree, and settlement-maintenance suites: 220/220 passed.
- Typecheck passed.

## Review

Both listed PR findings were independently classified as addressed by the
existing `4b3e913` production changes. Automated review found no applicable
finding in the PR diff; its only comment concerned an unchanged file imported
from `main`.
