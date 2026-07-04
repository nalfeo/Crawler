# Progress navigation suppression instrumentation

Follow-up Slice 2 for Floor 1 AI. This slice instruments the dominant pre-boss EXPLORE stall class so headless logs can separate ordinary EXPLORE wandering from EXPLORE frames caused by active progress-goal suppression.

## Apple estimate

- Declared: **3 apples**
- Actual: **3 apples**
- Verdict: **on-target** - touched AI decision typing, BehaviorTreeAI suppression bookkeeping, headless event logging, summaries, tests, review ledger, and deterministic seed artifacts without gameplay tuning.

Metric file: `docs/knowledge/metrics/apples/2026-07-03-progress-nav-instrumentation.json`.

## Summary

- Added typed telemetry-only decision debug payloads in `src/game/ai/types.ts`.
  - Debug state: `suppressedProgressNav`.
  - Suppression sources: `exploreDwellFixedPositionTarget`, `exploreDwellFrontierTarget`, `questProgressDwellWatchdog`, and fallback `progressGoalSuppressionWindow`.
  - `criticalChainPhase` uses PR #735's shipped taxonomy: `detour | pre-chain | shop | spell-broker | staircase | post-stairs | other`.
  - `AIDecision.state` remains the existing numeric gameplay state; `AIDecision.debug` is separate and never drives movement.
- Wired `BehaviorTreeAI` to classify suppressed fixed-position progress objectives.
  - Existing watchdogs now remember which suppression source set `progressGoalSuppressedUntilFrame`.
  - `findProgressObjective` records a one-poll pending debug payload when a fixed-position progress target is skipped solely because suppression is active.
  - The Explore action attaches that payload only if the tree actually falls through to EXPLORE, leaving ordinary EXPLORE unlabelled.
  - Debug payloads are cleared every poll, cloned in `getDecision()`, and reset with the provider.
- Wired headless telemetry.
  - `SimEvent.state` now emits `suppressedProgressNav` when decision debug is present.
  - Raw events include `baseState: "EXPLORE"` plus the typed `decisionDebug` payload.
  - Raw debug payloads include `criticalChainPhase` so future slices can distinguish pre-chain/shop/spell-broker/staircase suppression.
  - State-transition notes compare emitted string labels, so entry/exit from `suppressedProgressNav` is visible in JSONL.
  - `summarizeEvents()` naturally reports `suppressedProgressNav` as its own `stateMs` / `statePct` bucket.
  - `RunStats.aiTelemetry` now rolls up per-poll `decisionStateCounts`, `decisionStateMs`, `suppressedProgressNavCount`, and `suppressedProgressNavMs` so batch consumers can detect the stall class without parsing JSONL.
- Added tests.
  - `tests/game/behavior-tree-ai.test.ts` proves suppression fallback keeps `AIState.EXPLORE`, attaches `suppressedProgressNav`, records the blocked progress target, and clones debug payloads on read.
  - `tests/unit/ai-event-log.test.ts` proves summary bucketing, JSONL preservation, and event-state label selection.
  - `tests/headless/headless-runner-telemetry.test.ts` proves the headless runner rolls telemetry-only decision labels into `RunStats.aiTelemetry`.

## Files touched

- `src/game/ai/types.ts`
- `src/game/ai/bt-ai-provider.ts`
- `src/game/ai/event-log.ts`
- `src/game/ai/headless-runner.ts`
- `tests/game/behavior-tree-ai.test.ts`
- `tests/game/auto-progression-npc.test.ts`
- `tests/headless/headless-runner-telemetry.test.ts`
- `tests/unit/ai-event-log.test.ts`
- `docs/knowledge/review-ledgers/2026-07-03-progress-nav-instrumentation.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-03-progress-nav-instrumentation.json`
- `docs/knowledge/metrics/guard-telemetry/2026-07-03-progress-nav-instrumentation.json`
- `docs/knowledge/metrics/guard-telemetry/2026-07-04-progress-nav-instrumentation.json`

## Supporting evidence from stood-down Spell Broker slice

Read the preserved salvage-branch audit docs from `origin/nalfeo-floor1-spell-broker-timing-guard`:

- `docs/knowledge/handoffs/2026-07-03-floor1-spell-broker-chain-timing.md`
- `docs/knowledge/metrics/apples/2026-07-03-floor1-spell-broker-chain-timing.json`
- `docs/knowledge/review-ledgers/2026-07-03-floor1-spell-broker-chain-timing.review-ledger.json`

- PR #737 was closed/stood down; branch `nalfeo-floor1-spell-broker-timing-guard` is salvage/docs-only. Reviewed chain-filtering code is preserved only at closed PR #737 commit `009807ce` for salvage/reference, not as a dependency for this PR.
- That session found the pre-classified Spell Broker bucket was **0/14 baseline** and **0/14 post-chain-filtering**, with byte-identical dominant EXPLORE percentages.
- Interpretation from the handoff: those seeds wedge in pre-chain phases before `chainStatus.onCriticalPath` can arm; root cause is `progressGoalSuppressedUntilFrame` wedge-thrash around fixed-position NPC/room progress targets.
- This slice consumes PR #735's shipped phase names directly and keeps the Spell Broker chain timing work as supporting evidence, not a gameplay fix dependency.

## Verification

- `npx vitest run tests/unit/ai-event-log.test.ts tests/game/behavior-tree-ai.test.ts --reporter=dot` - green, 54 tests.
- `npx vitest run tests/headless/headless-runner-telemetry.test.ts` - green, 1 test.
- `npm run verify:fast` - green, 123 tests.
- `npm run verify:game` - green, 618 tests.
- `npm run verify` - green.
- `bash scripts/agent/lab-gate-check.sh` - green.
- `npm run verify:pr-prereqs` - green.
- `npm run telemetry:capture -- progress-nav-instrumentation` - wrote `docs/knowledge/metrics/guard-telemetry/2026-07-03-progress-nav-instrumentation.json` and refreshed `docs/knowledge/metrics/guard-telemetry/2026-07-04-progress-nav-instrumentation.json`.
- Review harness:
  - Plan review: `gpt-5.4`; 2 concerns, both resolved.
  - Code review: `claude-sonnet-4.6`; 4 rounds, clean.
  - Ledger validated: `docs/knowledge/review-ledgers/2026-07-03-progress-nav-instrumentation.review-ledger.json`.

## Headless artifacts

Artifacts are under:
`C:\Users\nalfeo\.copilot\session-state\dca3680f-0ca4-48db-b52a-318031a45f2a\files\progress-nav-instrumentation`.

Representative requested/nearby runs:

| Run                 | Summary                                                                                                                                                                 | Result                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| sword seed 36       | `sword-36-summary.json`, `sword-36-runstats.json`, `sword-36.jsonl`, `sword-36-console.txt`                                                                             | victory; `suppressedProgressNav` 0 ms |
| sword seed 2        | `sword-2-summary.json`, `sword-2-runstats.json`, `sword-2.jsonl`, `sword-2-console.txt`                                                                                 | victory; `suppressedProgressNav` 0 ms |
| sword seed 7 sample | `sword-7-spell-broker-sample-summary.json`, `sword-7-spell-broker-sample-runstats.json`, `sword-7-spell-broker-sample.jsonl`, `sword-7-spell-broker-sample-console.txt` | victory; `suppressedProgressNav` 0 ms |

The exact "Spell Broker bucket" seed list was not present in the checked-in handoffs, so I also ran a bounded sword seed search (`suppressed-search-results.json`) to prove the new label appears in real headless artifacts:

| Run           | Summary / stats                                                                       | Raw log                            | `suppressedProgressNav`                                                 |
| ------------- | ------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| sword seed 12 | `sword-12-suppressed-search-summary.json`, `sword-12-suppressed-search-runstats.json` | `sword-12-suppressed-search.jsonl` | event summary 1000 ms; `RunStats.aiTelemetry` 61 frames / 1016.7 ms     |
| sword seed 21 | `sword-21-suppressed-search-summary.json`, `sword-21-suppressed-search-runstats.json` | `sword-21-suppressed-search.jsonl` | event summary 26750 ms; `RunStats.aiTelemetry` 1641 frames / 27350.0 ms |

`runstats-refresh-status.json` lists all refreshed per-run stats artifacts. Event-summary milliseconds are sampled-window attribution; `RunStats.aiTelemetry` is per-poll frame attribution, so small differences are expected and deterministic.

Example raw event from seed 21 includes:
`state: "suppressedProgressNav"`, `baseState: "EXPLORE"`, `decisionDebug.source: "exploreDwellFixedPositionTarget"`, `decisionDebug.criticalChainPhase: "pre-chain"`, and `decisionDebug.blockedTargetReason: "Seeking Tutorial Goon to unlock the floor quest"`.

## Observe before done - real pipeline

Validation used `npm run ai:headless` and direct `runHeadless()` seed search artifacts. These exercise the real `BehaviorTreeAI.poll()` and `src/game/ai/headless-runner.ts` pipeline, not a lab-only harness.

## Scope notes

- No gameplay tuning was made.
- `progressGoalSuppressedUntilFrame` durations, watchdog thresholds, pathing targets, movement vectors, and planner estimates are unchanged.
- Requested sword seeds 2 and 36 no longer reproduce suppressed-progress samples in this branch, but the new instrumentation deterministically reports the class when it manifests (sword seeds 12 and 21).

## Next step

Use the new `suppressedProgressNav` bucket to tune or redesign suppression-window behavior in the next slice, especially for fixed-position objective dwell sources.
