# Session Handoff: Canonical Goobers feature-PR repass contract

## Date

2026-09-09

## Persona

QA Engineer

## Systems touched

ci-policy

## Apples

2 estimated, 2 actual - exact

## What Was Done

Clarified the feature-PR workflow's current-only repass contract and added a
deterministic assertion that implementation context cannot include historical
plan or self-output sources. Updated the Goobers configuration overview to
match the actual implement -> local verification -> review -> publish path.

## Verification

Ran the focused workflow contract tests (78 tests passed) and
`bash scripts/agent/verify-fast.sh` (passed).

## Risk

The change is limited to workflow documentation and contract assertions; the
runtime graph, escalation destinations, and credential boundaries are
unchanged.
