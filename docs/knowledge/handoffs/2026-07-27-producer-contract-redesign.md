# Producer contract-first orchestration redesign

**Date:** 2026-07-27  
**Session:** producer-contract-redesign  
**Apple estimate:** 3🍎 (tooling-only cap; executable planner, tests, and skill/persona docs)

## Systems touched

agent-personas, docs-tooling, mcp-tooling

## Summary

Redesigned the Producer around a validated planning contract rather than
keyword-only decomposition. Plans now expose a measurable hard gate, ranked
tiebreakers, confidence, delegation readiness, and dependency validation.

## Changes

- Added contract validation and cycle/dangling-edge checks to
  `scripts/agent/producer.ts`.
- Added regression coverage for missing gates, measurable gates, and dependency
  integrity.
- Reworked the Producer skill and persona guidance around contract-first
  clarification, explicit ownership, bounded delegation, and release-first
  handoff.
- Removed unsafe documentation patterns that interpolate untrusted request text
  into shell commands.

## Validation

- `git diff --check` passed.
- `npm run verify:fast` was attempted but could not run because the fresh
  worktree lacks installed TypeScript/ESLint dependencies; preflight dependency
  installation failed before validation.
- Review agents were run for adversarial planning, code review, and security.

## Follow-up

- Run the normal fast verification and review-ledger checks in an environment
  with dependencies installed.
- Keep the 90% planning-correctness gate as the primary Producer metric.
