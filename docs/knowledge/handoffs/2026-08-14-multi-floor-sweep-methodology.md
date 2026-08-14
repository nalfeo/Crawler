# Complete-floor sweep methodology

**Date:** 2026-08-14
**Apples:** 4🍎 (declared 4🍎)

## Systems touched

ci-policy, ai-runtime, release-baseline

## Summary

Expanded PR and release sweep coverage from Floor 1-only to every manifest-declared
implemented MVP floor. The approved release matrix is 300 blocking Floor-1 balance
runs, 150 report-only Floor-2 runs, and 150 report-only Floor-1 to Floor-2 chained
runs, preserving the 600-run release budget. PR coverage is 25 standalone Floor-1,
10 chained, and 15 standalone Floor-2 runs.

Added manifest-backed floor maturity and win-budget metadata, floor-aware headless
budgets, deterministic carryover progression, per-leg baseline diagnostics, and
run-count migration handling so the intentional 600-to-300 Floor-1 resize skips
only the incomparable historical sample. Restored downloadable `nanoid@3.3.17`.

## Verification

- Focused sweep, baseline, argument, and release-baseline tests: 57 passed.
- `npm run verify:fast`: typecheck, lint, changed tests, and integrity checks ran;
  the command is blocked by the repository's expired `brace-expansion` audit
  exception, not by this change.
- `npm ci` succeeded after restoring nanoid.

## Review

The 4🍎 review harness completed adversarial plan review, code review, multi-model
review, and the independent grade is pending packet generation because the existing
grade tool refuses this branch's oversized diff.

## Follow-up

Generalize `sweep-eval.ts`'s remaining Floor-1-specific budget and frame-cap
internals before allowing it to evaluate non-Floor-1 floors. The current guard
intentionally remains Floor-1-only; the general win-rate sweep is the multi-floor
entry point.
