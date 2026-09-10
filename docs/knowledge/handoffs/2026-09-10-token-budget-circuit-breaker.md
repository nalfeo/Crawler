# Handoff: Codex rollout token-budget circuit breaker

**Date:** 2026-09-10
**Apple estimate:** 🍎🍎🍎 (tooling-only cap)
**Actual:** 🍎🍎🍎

## Systems touched

docs-tooling, agent-memory

## Outcome

Added `npm run telemetry:token-budget`, a dependency-free, deterministic reader
for local Codex rollout JSONL logs. With an explicit file it reads that log;
without one it selects the newest `rollout-*.jsonl` under the local Codex
sessions directory.

It reports cumulative input, cached and uncached input, output and reasoning
tokens, response/tool-call/compaction counts, latest request input, a clearly
labelled current-context estimate, and the largest tool output in characters.
It exits nonzero for exceeded current-input, cumulative-input, response-count,
or context-estimate limits. The 10,000-character tool-output limit is a warning
by design, so it highlights a context sink without turning routine diagnosis
into a blocking failure. Every limit accepts `off` when a caller needs an
observational report.

Default limits are 50,000 current-request input, 500,000 cumulative input,
12 responses, and an 80,000-token current-context estimate when observable.

## Startup / rollout telemetry

Available parent baseline: the merged startup-contract change reduced root
`AGENTS.md` from 54,710 to 5,856 characters. The circuit breaker intentionally
preserves that reduction and adds no startup-loaded guidance.

The newest available local rollout when this change was validated reported
5,393,278 cumulative input tokens (5,095,040 cached, 298,238 uncached), 46
responses, 40 tool calls, zero compactions, a 144,690-token latest-input/context
estimate, and a 31,724-character largest tool output. The default tool-output
warning fired; explicit low-threshold coverage confirms budget exceedance returns
nonzero.

## Validation

- `npm run test:unit -- --run tests/unit/token-budget.test.ts` — 5/5 pass.
- `npm run verify:fast` — passed.
- `npm run scope` — completed after rebasing onto merged parent.
- `npm run telemetry:token-budget -- --json --max-current-input off --max-cumulative-input off --max-responses off --max-context off` — read a real rollout and emitted the expected warning.
- Direct low-threshold probe and deterministic unit test verified nonzero exit behavior.
- `git diff --check` — passed before handoff addition.

## Integration

The original stack parent, PR #4539 (`codex/shrink-agents-startup`), merged while
this work was underway. The child branch was checkpointed and the standard
`npm run sync:main -- --reason periodic` flow rebased it cleanly onto
`f76d5cf79` (merged parent on `origin/main`); no conflicts occurred.

## Unresolved / next steps

- No unresolved implementation issues.
- Run `npm run telemetry:token-budget -- --help` for option names and use
  `--json` for automation.
