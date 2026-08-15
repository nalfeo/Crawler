# Handoff: Shared RunStats and run bundles

## Systems touched: ai-combat-balance, devtools

## Apples

Estimated: 4🍎 — actual: 4🍎. Extracted the headless RunStats assembly seam,
added human-run harvesting, bounded log capture, RunBundle contracts, terminal
scene hooks, tests, and the required review harness.

## Summary

- `src/shared/run-bundle.ts` defines the generic bundle contract and defensive
  payload copying.
- `src/shared/run-stats-collector.ts` provides the pipeline-agnostic assembly
  seam; headless output remains unchanged.
- `MainGameScene` assembles bundles on death, floor completion, timeout, victory,
  and a future active-run quit path. The bootstrap exposes an `onRunBundle`
  callback and dispatches a browser `crawler:run-bundle` event by default.
- `src/shared/logger.ts` keeps a fixed-size, level-aware ring buffer with
  sequence cursors.
- Fun-score and sweep-result validation/rendering accept the new `quit` outcome.

## Verification

- `npm run typecheck`
- Targeted logger and run-bundle unit tests: 11 passed.
- `npm run verify:fast`: passed.
- Focused sword seeds 1–3 RunStats fingerprint: byte-identical.
- Review ledger validated as a complete 4🍎 ledger.

## Follow-up

- PR2 can subscribe to `crawler:run-bundle` or pass an `onRunBundle` callback to
  add upload/persistence without changing the scene pipeline.
- Add richer human-only metrics and bound/persist the recorder event payload as
  the permanent telemetry schema is finalized.
