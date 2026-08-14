# Dependency integrity gate

## Status

Implemented and ready for review.

## Systems touched

ci, security, dependency-management

## Summary

Removed the shared `node_modules` cache false-green path and made CI run `npm ci`
on every dependency-using job. Dependency changes now require a cacheless,
cache-purged install, exact lockfile/package manifest pairing, canonical npm
tarball metadata, and a seven-day registry-proxy quarantine.

The existing CI incident loop now marks genuine startup/admin interventions and
includes explicit recurrence-prevention instructions, while excluding the known
automatic retrigger path for parked CI checks. The broken `nanoid` override was
corrected from `3.3.18` to the available `3.3.17` release.

## Validation

`npm ci --ignore-scripts --no-audit --no-fund`, `npm run verify:fast`,
`npm run security:exact-deps`, and focused lock-integrity tests passed.
The broad guard suite still reports unrelated Windows-path/esbuild and
`npm-audit` baseline failures.
