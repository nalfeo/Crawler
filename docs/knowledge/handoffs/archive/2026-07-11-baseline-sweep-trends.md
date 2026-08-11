# Handoff: Add five-release baseline trends

**Date:** 2026-07-11
**Session:** baseline-sweep-trends
**Branch:** nalfeo-baseline-sweep-trends

## Summary

Release baseline comments now show the five most recently recorded win-rate baselines,
oldest to newest, with each release's percentage-point change from its predecessor.

**Changes made:**

- Added a deterministic baseline-comment formatter that combines the current sweep
  result with the published `baselines/index.json` history.
- Updated the post-release workflow to pass the freshly published index to the formatter.
- Added focused coverage for short histories, five-entry truncation, predecessor deltas,
  run-link fallback, and invalid history.

## Verification

`npm run verify:fast` and `npm run verify` passed. The focused formatter suite
renders the requested `84% (252/300)` headline and a chronological five-release
trend with signed deltas.

## Systems touched

ci-policy

## Apples

🍎🍎 estimated, 🍎🍎 actual — exact.

## Unresolved issues

None.
