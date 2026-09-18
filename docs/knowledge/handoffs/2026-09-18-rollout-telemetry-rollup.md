# Handoff — Explicit rollout telemetry rollup

## Date

2026-09-18

## Persona

Producer (tooling/QA seam)

## Systems touched

agent-tooling, velocity-telemetry, unit-tests

## Apples

2🍎 low

## What Was Done

Added `npm run telemetry:rollup -- [--json] rollout-a.jsonl ...`, a deterministic
bounded rollup that reads only explicitly supplied paths. It reports per-file and
aggregate response, input/cache/output/reasoning, cache-hit percentage,
compactions, tool calls, median/max input, malformed lines, unknown events, and
truncation diagnostics. It caps input at 10 files and 100,000 non-empty-capable
lines per file; paths and diagnostics are bounded and no event payloads are
printed. Missing optional telemetry is `null` in JSON and `unavailable` in text.

Fixtures and focused tests cover aggregation, cache math, absent fields,
malformed/unknown lines, compaction/tool events, deterministic ordering, and the
10-file cap.

## Validation

- `git diff --check` — pass.
- `npm run preflight` — blocked before repository checks: host Node is 24.19.0,
  while `.node-version` requires 22.23.2; dependency installation therefore
  fails the package engine gate and `node_modules` is absent.
- Focused Vitest, lint, typecheck, `verify:fast`, and PR prerequisites remain to
  be rerun under Node 22.23.2.

## What's Next / Blockers

Run the focused test and proportional repository gates under Node 22.23.2,
format if needed, then publish a ready-for-review PR after `sync:main` and
`verify:pr-prereqs` succeed.
