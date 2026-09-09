# Session Handoff: Require explicit Goobers completion state

## Date

2026-09-09

## Persona

Producer

## Systems touched

ci-policy,mcp-tooling,docs-tooling

## Apples

2🍎 estimated

## What Was Done

Extended the `crawler.goobers.summary/v1` contract so the existing four-line
Description/Systems/Verification/Risk close-out block must explicitly say either
`Session is fully complete` or `Session is not fully complete` in its
Description. Updated the canonical schema example, validator guidance, coder
instructions, and unit fixtures. The existing `inputsFrom: implement.summary`
wiring on all three issue close-out branches remains intact, so the validated
human-readable summary continues to reach the final issue comment while
machine-readable outputs remain unchanged.

## Verification

`node .github/scripts/validate-goobers-contracts.mjs` passed all 9 workflow
schemas and 27 fixtures. Focused Goobers contract and lifecycle tests passed
(66 tests). `bash scripts/agent/verify-fast.sh` passed after the corrected
fixture.

## Risk

Low: this is a validation and authoring-contract tightening change only; it
does not alter gameplay or runtime simulation behavior. Existing in-flight
`crawler.goobers.output/v1` summaries retain their non-empty-string semantics.
