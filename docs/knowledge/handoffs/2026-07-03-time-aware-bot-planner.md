# 2026-07-03 - Time-aware bot planner

## Summary

Implemented a small vertical slice of the time-aware Floor 1 AI planner:

- Added a pure run planner that estimates remaining critical-path work, required time, slack, and urgency from authoritative Floor 1 state.
- Added a pure tactical opportunity evaluator that scores reachable pickups and debug-only enemy packs by value/sec, path-relative detour cost, danger, and urgency.
- Integrated planner/evaluator output into `BehaviorTreeAI` objective travel without adding BT states. Accepted pickups feed the existing `travel-steering.ts` loot channel, and legacy Track-B loot/farm pulls are suppressed on frames where tactical travel owns the pickup.
- Extended travel-steering debug with selected candidate, selected pickup, score, loot/farm bonus, and candidate position.
- Exposed `getTacticalRunDebug()` for current critical-path objective, remaining time, estimated required time, slack, urgency, and opportunity accept/reject reasons.
- Fixed review feedback by replacing planner control flow that parsed human-readable decision reasons with typed `RunPlannerCurrentTargetKind` derived from Floor 1 state/components.

## Files touched

- `src/game/ai/run-planner.ts`
- `src/game/ai/tactical-opportunity-evaluator.ts`
- `src/game/ai/bt-ai-provider.ts`
- `src/game/ai/bt-ai-tuning.ts`
- `src/game/ai/travel-steering.ts`
- `tests/game/ai-run-planner.test.ts`
- `tests/game/tactical-opportunity-evaluator.test.ts`
- `tests/game/behavior-tree-ai.test.ts`
- `tests/game/travel-steering.test.ts`
- `docs/knowledge/review-ledgers/2026-07-03-time-aware-bot-planner.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-03-time-aware-bot-planner.json`

## Verification

- `npm run verify:fast` passed after implementation.
- Focused planner/evaluator/travel/BT tests passed after the typed target-kind review fix.
- `npm run verify:fast` passed after the review fix and formatting.
- Real headless Floor 1 artifact: `npm run ai:headless -- --seed 1 --weapon sword --max-frames 23760 --max-time-ms 300000 --progress 12000 --event-summary C:\Users\nalfeo\.copilot\session-state\2facff58-d781-4940-a766-10fbfdbb9cca\files\time-aware-bot-headless-seed1-sword-summary.json` ended `VICTORY` at 267.2s game time.
- `VERIFY_FULL=1 npm run verify` passed through typecheck, lint, format, dead-code, guards, unit/integration, build, and the headless Floor 1 completion gate; it stopped only at PR prerequisites before this handoff existed. Rerun after this handoff should clear the handoff prerequisite.
- Review ledger validates as a 4-apple ledger.

## Review harness

- Apple estimate: 4.
- Dual-plan synthesis complete.
- Plan review complete.
- Code-review loop clean.
- Multi-model review found one valid concern (reason-string parsing), fixed via typed target kind, and reran clean.

## Unresolved issues

- None known.

## Recommended next steps

- Rerun `VERIFY_FULL=1 npm run verify` now that the handoff exists.
- Optional future slice: make enemy-pack farming actionable instead of debug-only once broad win-rate data confirms pickup-only tactical travel is stable.
