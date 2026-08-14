# Persist full release-sweep RunStats telemetry

## Date

2026-08-13

## Persona

DevOps Engineer with QA Engineer coverage for the persistence contract.

## Systems touched

ci-policy, ai-combat-balance

## Apples

3 apples estimated, 3 apples actual (exact). The change adds a typed persistence
boundary, updates the release workflow, and proves the 600-run payload through
the real fun-score normalizer.

## What changed

- `ai:winrate-sweep` now stores every complete `RunStats` object at root
  `runs`, in deterministic weapon/seed task order, alongside all existing
  aggregate, metric, failure, and slow-victory fields.
- `scripts/agent/perf/release-baseline.ts` owns the release-baseline persistence
  contract. It validates the payload with `normalizeFunSessions`, requires
  `runs.length === totalRuns`, rejects provenance overwrite, and validates the
  serialized JSON round trip before writing.
- The deploy workflow now uses that tested publisher to add release metadata.
  The exact enriched `.cache/baseline/baseline.json` is copied to
  `baselines:by-sha/<commit>.json` and uploaded as the 90-day workflow artifact,
  so both durable and diagnostic storage preserve all 600 runs.
- `baselines:index.json` remains a compact aggregate-only index, preserving
  existing baseline lookup, viewer, and release-comment consumers.
- `ai-sweep.yml` remains unchanged: its RunRow shards and leaderboard are the
  search/evaluation pipeline, not the post-release 600-run baseline publisher.

## Storage contract

Each future release baseline has this backward-compatible top-level shape:

```text
{
  meta: { commit, commitDate, capturedAt, runId, runUrl, sweep, ... },
  ...existing aggregate fields,
  runs: RunStats[600]
}
```

`wallTimeMs` is intentionally retained because the requirement is complete
`RunStats`; unlike gameplay fields, wall time can differ across same-commit
reruns and is not used for deterministic comparisons.

## Verification

- Focused producer/publisher, fun-score input, and deploy-workflow suites:
  24 tests passed.
- `npm run typecheck`: passed.
- `npm run verify:fast`: passed.
- The persistence test captures one real `runHeadless` result, expands it to 600
  distinguishable runs, publishes and serializes it, then verifies
  `normalizeFunSessions` accepts all 600 while preserving optional nested
  `spawnerArenas` and `lootEfficiency` telemetry.

## Review

- Plan review: `gpt-5.4`, four concerns resolved, `plan_divergence: minor`.
- Code review: `claude-sonnet-4.6`, clean in round one.
- Independent grade: `gemini-3.1-pro-preview`, pass with 5/5 in all criteria.
- Ledger:
  `docs/knowledge/review-ledgers/2026-08-13-persist-release-telemetry.review-ledger.json`.

## Follow-up

The publisher currently reparses every full `by-sha` file when rebuilding the
compact index. This is correct and does not truncate data; if baseline history
grows enough for that cost to matter, publish a compact summary sidecar rather
than weakening the full-run artifact.
