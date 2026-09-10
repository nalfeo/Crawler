# Handoff: Repair fast-uri audit

## Date

2026-09-02

## Systems touched

ci-policy

## Apples

Estimated: 2

Actual: 2

Verdict: Exact. The repair remained a two-file dependency pin plus the required handoff.

## Summary

Cleared the train-wide high-severity npm audit blocker by updating the existing
`fast-uri` override from `3.1.5` to patched version `3.1.6` and regenerating its
lockfile resolution. No unrelated dependency versions changed.

## Verification

- `npm ci --package-lock-only --ignore-scripts --no-audit --no-fund`
- `npm run security:audit`
- `npm run security:exact-deps`
- `npm run security:lock-integrity`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Notes

- The lock-integrity check confirmed that `fast-uri@3.1.6` uses the canonical
  npm registry tarball and SHA-512 integrity and is outside the proxy quarantine
  window.
- This repair intentionally remains separate from PR #4123 so its CI recovery
  parser changes stay uncontaminated.
