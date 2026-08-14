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
revision-gated run-count migration so the intentional 600-to-300 Floor-1 resize
skips only the incomparable historical sample and any undeclared run-count change
still fails closed.

## Verification

- Focused sweep, baseline, argument, and release-baseline tests: 57 passed.
- `npm run verify:fast`: typecheck, lint, changed tests, and integrity checks ran;
  the command is blocked by the repository's expired `brace-expansion` audit
  exception, not by this change.
- `npm ci` succeeds on the repository's pinned `nanoid@3.3.18` override; the
  temporary 3.3.17 downgrade was reverted because it reintroduced a blocking
  high-severity audit finding.

## Review

The 4🍎 review harness completed all stages: adversarial plan review, a clean
two-round code review, a clean two-round multi-model review, and the independent
grade (`gemini-3.1-pro-preview`, verdict `pass`, zero findings). See
`docs/knowledge/review-ledgers/2026-08-14-multi-floor-sweep-methodology.review-ledger.json`.

PR review follow-up landed afterwards: workflow/matrix parity is now covered by
`tests/unit/sweep-legs-workflow-parity.test.ts`, the baselines index derivation
moved into the unit-tested `scripts/agent/perf/baseline-index.ts` (it previously
dropped `legs`, disabling every per-leg diagnostic), `--max-frames` is forwarded to
chained runs, chained coverage is derived with `resolveFloorChain`, and the
progression gate now asserts the Floor-1 clear plus a concrete restored carryover
value.

## Follow-up

Generalize `sweep-eval.ts`'s remaining Floor-1-specific budget and frame-cap
internals before allowing it to evaluate non-Floor-1 floors. The current guard
intentionally remains Floor-1-only; the general win-rate sweep is the multi-floor
entry point.
