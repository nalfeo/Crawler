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
Description/Systems/Verification/Risk close-out block must end with either
`Session is fully complete.` or `Session is not fully complete.` in its
Description. Updated the canonical schema example, validator guidance, coder
instructions, and unit fixtures. Before each final issue close-out branch, an
unprivileged deterministic task now derives that declaration from the terminal
outcome while preserving the coder-authored human-readable content: successful
PR opening is complete; needs-human and needs-remediation are incomplete.

## Verification

`node .github/scripts/validate-goobers-contracts.mjs` passed all 9 workflow
schemas and 28 fixtures. Focused Goobers contract and lifecycle tests passed
(117 tests). `npm run verify:fast` passed after correcting the directly coupled
terminal-gate assertions.

## Risk

Low: this is a validation and authoring-contract tightening change only; it
does not alter gameplay or runtime simulation behavior. Existing in-flight
`crawler.goobers.output/v1` summaries retain their non-empty-string semantics,
and summary rewriting runs outside issue-write credential scope.
