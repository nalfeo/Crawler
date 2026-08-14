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
automatic retrigger path for parked CI checks. That exclusion is classified by
the immutable workflow **path** (`AUTO_RETRIGGER_WORKFLOW_PATHS` in
`ci-recovery/state.mjs`, now shared with `action-required-retrigger.mjs`), not by
the mutable display name, so renaming a workflow cannot change recovery
behaviour.

Because CI now runs `npm ci` on every dependency-using job, the root
`postinstall` browser download had to be gated: `playwright install chromium` is
an explicit CLI call and Playwright only honours
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` in its own postinstall hook, so every job was
pulling ~290 MB of Chromium/FFmpeg. `postinstall` now delegates to
`scripts/agent/install-playwright-browser.mjs`, which makes that environment
variable authoritative; the shared setup action always sets it and installs the
browser only in its existing cache-aware Playwright steps.

The `nanoid` override stays at `3.3.18` (the release that patches
GHSA-2v37-7h3g-55p8); an earlier downgrade to `3.3.17` reintroduced the
high-severity advisory and has been reverted along with its lockfile change.

## Validation

`npm run verify:fast`, `npm run verify:pr-prereqs`, `npm run security:audit`
(0 findings), `npm run security:exact-deps`, `npm run security:lock-integrity`,
and the focused `check-lock-integrity`, `ci-recovery/state`,
`action-required-retrigger`, and `detect-change-scope` suites all pass.
