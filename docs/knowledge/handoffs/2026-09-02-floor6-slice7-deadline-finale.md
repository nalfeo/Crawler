# Handoff: Floor 6 Slice 7 — Deadline finale

## Systems touched

floor-generation, ai-behavior-tree, enemies, inventory

## Apples

4 apples estimated, 4 apples actual (exact). The slice stayed in existing Floor 6 scenario/headless seams but still touched manifest schema/data, runtime phase authority, headless automation, terminal state, and focused regression coverage.

## Summary

Implemented Floor 6 Slice 7's terminal phase arc inside the existing `floor6DefenseDirectorSystem` authority:

- Defense waves now resolve as escalating authored acts instead of allowing later acts to release before earlier acts clear.
- Cleared acts enter bounded `BREAK` phases that clear hostile Floor 6 raiders/debt while preserving legal build/upgrade state.
- Added an authored `finale` manifest block with fixed Broadcast Deadline boss data, bounded add entries, break duration, boss timeout, and one-shot payout values.
- Added explicit Floor 6 runtime latches for finale boss defeat, terminal outcome count, victory payout count, and exit-open count; `getFloor6RunOutcome()` reads those latches rather than entity absence.
- Allowed existing Floor 6 towers to fight during `FINALE`; build/sell/upgrade transactions remain phase-locked to `DEFEND`/`BREAK` and headless tower requests retry while phase-locked.
- Marked Floor 6 as a terminal run victory in the scenario presentation contract.
- Post-review fixes added post-core Floor 6 terminal reconciliation, stable finale add IDs, richer transition trace context, Floor 6 headless stall progress scoring, and manifest validation for normal wave archetype references.

## Files touched

- `src/game/floor6Scenario.ts`
- `src/game/ai/headless-runner.ts`
- `src/game/scenarioDefinitions.ts`
- `src/shared/floor-types.ts`
- `src/shared/floor-manifest.ts`
- `src/shared/data/floors/floor6.manifest.json`
- `src/shared/data/enemies.floor6.json`
- `tests/unit/floor6-wave-director.test.ts`
- `tests/unit/floor6-manifest-economy-schema.test.ts`
- `tests/headless/floor6-wave-director-obs.test.ts`
- `tests/headless/floor6-economy-obs.test.ts`

## Verification run

- `bash scripts/agent/preflight.sh` — passed before code changes.
- Before implementation: `npx vitest run --project headless tests/headless/floor6-economy-obs.test.ts tests/headless/floor6-wave-director-obs.test.ts` passed and confirmed the pre-Slice-7 baseline where Floor 6 stayed non-terminal in `DEFEND`.
- `npm run typecheck` — passed after implementation.
- `npx vitest run --project unit tests/unit/floor6-wave-director.test.ts tests/unit/floor6-manifest-economy-schema.test.ts` — failed once while break cleanup only removed ledger-tracked raiders and an older test still expected deferred victory; fixed both.
- `npx vitest run --project unit tests/unit/floor6-wave-director.test.ts tests/unit/floor6-manifest-economy-schema.test.ts` — passed.
- `npx vitest run --project unit tests/unit/floor6-*.test.ts && npx vitest run --project headless tests/headless/floor6-*.test.ts` — failed once while old headless assertions expected all waves by frame 2000 and scripted tower requests consumed `phase-locked` attempts; fixed assertions and retry behavior.
- `npx vitest run --project unit tests/unit/floor6-*.test.ts && npx vitest run --project headless tests/headless/floor6-*.test.ts` — passed.
- `npm run typecheck` — passed.
- `npx vitest run --project unit tests/unit/floor6-*.test.ts tests/unit/scenario-definitions.test.ts && npx vitest run --project headless tests/headless/floor6-*.test.ts` — passed.
- `bash scripts/agent/verify-fast.sh` — passed.
- Review harness for the 4-apple change ran two independent post-diff reviews; their actionable findings were batched into one fix pass.
- `npm run format:check` — initially flagged `src/game/floor6Scenario.ts`; `npx prettier --write src/game/floor6Scenario.ts` fixed it.
- `npm run format:check && npm run typecheck && npm run test:unit -- tests/unit/floor6-wave-director.test.ts tests/unit/floor6-manifest-economy-schema.test.ts && npm run test:headless -- tests/headless/floor6-economy-obs.test.ts tests/headless/floor6-wave-director-obs.test.ts` — passed after review fixes.
- `npm run test:headless -- tests/headless/floor6-economy-obs.test.ts` — passed with `questStallFrames: 3000`, covering the Floor 6 progress-score branch instead of disabling the watchdog.
- `bash scripts/agent/verify-fast.sh` — passed after review fixes (806 test files / 11,377 tests plus data-contract and integrity checks; shallow-clone silent-revert guard skipped locally as expected).

## Runtime observation

- Before: the real Floor 6 headless pipeline with seed 606 could collect loot, build, upgrade, and fight, but Slice 6 left the floor in `DEFEND` with no terminal victory path.
- After: a real `runHeadless(new BehaviorTreeAI({ seed: 606 }), { floorId: 'floor6', seed: 606, maxFrames: 7000, questStallFrames: 3000 })` run reaches `VICTORY`, enters and exits two breaks, records `hostileActivityDuringBreak=0`, defeats the Broadcast Deadline, records `terminalOutcome='victory'` and `terminalOutcomeCount=1`, awards `victoryPayoutCount=1`, opens `exitOpenCount=1`, and reports both hero and tower damage contributions.

## Unresolved issues

- Numeric balance remains deferred to S9 per the Floor 6 bible/spec. The new boss/add/break/payout values are operational defaults to make the Slice 7 contract executable and observable.
- S8 still owns player-facing HUD/cue/readability work for finale and break presentation.

## Recommended next steps

- Run `npm run verify:pr-prereqs` after the review-fix commit.
- Run automated code review, CodeQL checker, and final secret scan before closeout.
- Let S8 consume the new `Floor6DefenseRunStats` fields for HUD/cue presentation rather than re-deriving phase or terminal state.
