# Bundled baseline regression CLI recovery

**Date:** 2026-08-15
**Apples:** 2🍎 (declared 2🍎, actual 2🍎)

## Systems touched

ci-policy, release-baseline

## Summary

The signature persistence import made the prebundled win-rate sweep load the
baseline regression CLI. Its source-path main guard was true for the generated
bundle, so it exited when standalone baseline environment variables were absent.
The guard now follows the existing release-baseline convention and does not run
when the prebundle launcher sets `CRAWLER_PREBUNDLED_ENTRY`.

## Files touched

- `scripts/agent/perf/baseline-regression-check.ts`

## Verification

- `npm run test:unit -- tests/unit/agent/headless-bundle.test.ts tests/unit/baseline-regression-check.test.ts`
- `node scripts/agent/perf/prebundle-cli.mjs --entry winrate-sweep --seeds 1-2 --weapons sword --max-frames 1 --workers 2 --skip-events`
- `npm run verify:fast`

## Unresolved issues

None known.
