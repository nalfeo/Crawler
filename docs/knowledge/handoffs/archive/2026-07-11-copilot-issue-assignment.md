# Session Handoff: Copilot Issue Assignment

## Date

2026-07-11

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎

## What Was Done

- Replaced issue intake's REST assignee request with the PAT-backed GraphQL
  `replaceActorsForAssignable` mutation already proven by repository automation.
- Required the mutation response to contain Copilot before intake posts or updates
  the kickoff comment.
- Added regression coverage for successful actor-ID assignment ordering and for
  suppressing misleading comments when assignment does not persist.

## Verification

- Before: Issue Copilot Intake runs `29168539637` and `29169545711` posted kickoff
  comments, then failed because Copilot was absent from the issue assignees.
- After: `.github/scripts/ci-recovery/issue-intake.test.mjs` proves assignment
  precedes comment mutation and assignment failure performs no comment API calls.
- Live artifact: applying the same GraphQL actor-ID mutation to issue #1067
  persisted `Copilot` in the issue's assignee list.

## Key Decisions Made

- Reuse the repository's working GraphQL assignment path instead of attempting to
  special-case Copilot through the ordinary REST assignees endpoint.
- Fail before writing the kickoff comment so the visible issue state never implies
  that an agent was launched when assignment failed.

## What's Next / Blockers

- Auto-merge is armed. No known blockers remain.
