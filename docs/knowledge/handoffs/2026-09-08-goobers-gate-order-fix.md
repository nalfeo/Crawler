# Session Handoff: Reorder Goobers feature-PR verification gates

## Date

2026-09-08

## Persona

QA Engineer

## Systems touched

ci-policy

## Apples

2 estimated

## What Was Done

Moved the crawler feature-PR workflow's branch push after successful local
verification and agent review. The successful path is now
`implement -> local-ci -> local-gate -> review -> push-branch -> open-pr`.
The workflow contract test also asserts the exact path, direct local failure
and infrastructure retry routes, reviewer defect loop, and human escalation
branches.

## Verification

Ran the focused Goobers workflow and contract tests (85 tests passed), the
Goobers contract schema validator (9 workflows and 27 fixtures passed), and
`bash scripts/agent/verify-fast.sh` (passed).

## Risk

The change only alters deterministic workflow sequencing and contract
assertions; credential scopes and all existing escalation destinations remain
unchanged.
