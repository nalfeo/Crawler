# Expiry-extension guard generalization

**Date:** 2026-08-01  
**Branch:** feature/expiry-guard-generalization  
**Apple estimate:** 1🍎  
**Closes:** nalfeo/Crawler#2596

## Summary

Generalized the expiry-extension guard in `scripts/agent/security/npm-audit.mjs` so it covers **both** exported exception arrays (`AUDIT_EXCEPTIONS` and `TEMP_DEPENDENCY_EXCEPTIONS`), and added a fail-closed check that errors out if a new `expiresOn`-bearing exported array is added without registering it.

Prior to this change, the guard's extraction step (`extractAuditExceptionsFromSource`) was hardcoded to the `AUDIT_EXCEPTIONS` array by name. `TEMP_DEPENDENCY_EXCEPTIONS`, which sits eight lines above it in the same file and has the identical shape, was completely unguarded — someone could silently bump its `expiresOn` without updating `reason`.

## Files touched

- `scripts/agent/security/npm-audit.mjs`
- `scripts/agent/security/npm-audit.test.mjs`

## What changed

### `npm-audit.mjs`

1. Added `fileURLToPath` to the `node:url` import (needed to read the current source file).
2. Added `KNOWN_EXPIRY_ARRAY_NAMES = ['AUDIT_EXCEPTIONS', 'TEMP_DEPENDENCY_EXCEPTIONS']` — the registry of guarded arrays.
3. Added `LIVE_EXPIRY_ARRAYS` (internal) — maps each known array name to its live export.
4. Added `extractNamedExceptionsFromSource(source, arrayName)` — the generic, parameterized extraction function.
5. Kept `extractAuditExceptionsFromSource(source)` as a backward-compatible wrapper.
6. Added `findUnknownExpiryArrays(source)` — scans source for exported arrays that contain `expiresOn` but are not in `KNOWN_EXPIRY_ARRAY_NAMES`.
7. Updated `getReasonRestatementViolationsForCurrentBranch()`:
   - Reads the current source file from disk and calls `findUnknownExpiryArrays` — errors out (exit 2) if any unknown `expiresOn`-bearing array is found.
   - Iterates over `KNOWN_EXPIRY_ARRAY_NAMES`, skipping arrays that didn't exist at the base ref.
   - Tags each violation with `arrayName`.
8. Updated `main()` error message to use `violation.arrayName` instead of hardcoded `'AUDIT_EXCEPTIONS'`.

### `npm-audit.test.mjs`

Added imports for `KNOWN_EXPIRY_ARRAY_NAMES`, `TEMP_DEPENDENCY_EXCEPTIONS`, `extractNamedExceptionsFromSource`, `findUnknownExpiryArrays`.

New tests (6):
- `extractNamedExceptionsFromSource extracts AUDIT_EXCEPTIONS by name`
- `extractNamedExceptionsFromSource extracts TEMP_DEPENDENCY_EXCEPTIONS by name`
- `extractNamedExceptionsFromSource throws for a missing array`
- `KNOWN_EXPIRY_ARRAY_NAMES lists both exception arrays`
- `findUnknownExpiryArrays returns empty for source with only known arrays`
- `findUnknownExpiryArrays detects an unknown expiresOn-bearing array`
- `findUnknownExpiryArrays ignores arrays without expiresOn`
- `CLI exits 1 for TEMP_DEPENDENCY_EXCEPTIONS expiresOn extension without reason update`
- `CLI exits 2 when current source contains an unknown expiresOn-bearing array`
- `every real temp dependency exception has a well-formed expiresOn date`

## Verification

All 34 tests pass: `node --test scripts/agent/security/npm-audit.test.mjs`  
Verified locally; no CI failures introduced.

## Systems touched

security

## Unresolved issues

None.

## Recommended next steps

When the postcss `TEMP_DEPENDENCY_EXCEPTIONS` entry expires (2026-08-06), remove the entry and the `overrides` pin from `package.json` — do not extend the date.
