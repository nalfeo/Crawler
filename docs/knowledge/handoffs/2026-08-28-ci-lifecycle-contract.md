# Handoff: CI lifecycle contract foundation

## Date

2026-08-28

## Persona

Producer

## Systems touched

ci-policy, agent-tooling

## Apples

3🍎 estimated, 3🍎 actual (exact). Tooling-only cross-system schema, inventory,
validator, and lease transition checks.

## Summary

Implemented the Phase 0 fail-closed lifecycle foundation for issue #3840:
the six-workflow mutation inventory, v1 invocation/state schema, deterministic
offline validator, valid/invalid fixtures, CI job wiring, invariant tests, and
ADR 0093 single-writer lease design. No shadow-mode invocation or live ownership
behavior was changed.

## Verification

`npm run validate:ci-contract` and `node --test tests/unit/ci-lifecycle-contract.test.mjs`
pass. The authoritative real artifact is the CI workflow validation job and the
offline validator; no game lab applies.

## Plan verdict

Recommended. The hard gate is the validator exiting 0 only with all six inventory
rows, valid v1 fixtures, and lease/invariant transitions.
