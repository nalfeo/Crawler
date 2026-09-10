# 2026-09-02 Goobers shadow parity hardening

## Systems touched

ci-policy

## What changed

- Tightened the shadow-mode marker parser so quoted and malformed resolution markers are rejected instead of treated as valid closures.
- Updated the legacy and shadow marker-state evaluators to require a genuine resolved marker before a thread is considered resolved.
- Added regression coverage to ensure invalid markers stay unresolved and parity remains deterministic.

## Verification

- `npx vitest run tests/unit/goobers-shadow.test.ts`
- `node .github/scripts/validate-goobers-contracts.mjs`

## Status

The Goobers Phase 1 shadow path remains read-only and deterministic, with marker parity enforced before any live lifecycle mutation is allowed.
