# Handoff — Floor 1 Spell Broker chain timing guard (Slice 2, stacked on PR #735)

**Date**: 2026-07-03
**Branch**: `nalfeo-floor1-spell-broker-timing-guard`
**Base**: `nalfeo-floor1-post-boss-stairs-slack` (PR #735, auto-merge armed)
**Apple estimate → actual**: 4🍎 → 4🍎 (matched)
**Review ledger**: `docs/knowledge/review-ledgers/2026-07-03-floor1-spell-broker-chain-timing.review-ledger.json` (valid 4-apple, all 4 stages)

## Summary

Second slice in the Floor 1 AI failure-bucket cleanup. Targets the "Spell Broker / Slime Rat chain timing" bucket (14/60 headless failures in the pre-classified sweep). Extends PR #707's segment-based run planner with **chain-scoped urgency / slack** and uses those signals to (a) tighten tactical opportunity budget during the chain and (b) bypass the `progressGoalSuppressedUntilFrame` dwell watchdog on 3 chain-critical position targets when chain urgency saturates.

**Explicitly does NOT introduce** a pairwise node-to-node travel-time estimator, a Floor 1 objective-node registry, or any parallel to `Floor1RunPlan.estimatedTravelMs`. Chain math consumes only the existing `RunPlanSegment.travelMs` field (from PR #707 `estimateSegmentMs`). PR #735 owns the shared perfect-world travel-time API (`src/game/ai/objective-travel-estimate.ts` + `Floor1RunPlan.estimatedTravelMs`); this slice stays consumer-side. Session 1 intentionally did not change `RunPlanSegment` shape, so `RunPlanSegment.criticalChainPhase` is added here.

## What changed

- `src/game/ai/run-planner.ts` — added `RunPlanCriticalChain` union `'pre-chain'|'shop'|'spell-broker'|'staircase'|'post-stairs'|'other'`, `criticalChainPhase` on `RunPlanSegment` (name aligned with Session 1's suggestion), `RunPlanChainStatus` interface, `spellBrokerChain: RunPlanChainStatus` on `Floor1RunPlan`, `computeSpellBrokerChainStatus` pure helper.
- `src/game/ai/bt-ai-provider.ts` — two integrations:
  - `evaluateTacticalObjectiveOpportunities`: `chainBeeline` detour tightening when `onCriticalPath && !complete && slackMs <= 0` (mirrors the existing quest-giver-detour opportunity params: `maxDetourFt = TRIVIAL`, `maxAccepted = 1`).
  - `findProgressObjective`: fresh per-tick `estimateCurrentRunPlan` + `chainSuppressionOverride = onCriticalPath && !complete && urgency >= CHAIN_SUPPRESSION_OVERRIDE_URGENCY`, applied only to 3 pre-completion chain-critical position targets (Broker, Slime Rat room, spell reward return). Staircase-boss gate is post-`complete` and therefore not overridden by construction (documented).
- `src/game/ai/bt-ai-tuning.ts` — new named constant `CHAIN_SUPPRESSION_OVERRIDE_URGENCY = 0.75` with docstring.
- `tests/game/ai-run-planner.test.ts` — +7 planner unit tests in `describe('spell-broker chain breakdown')`.
- `tests/game/behavior-tree-ai.test.ts` — +5 BT integration tests.

## What was intentionally removed after multi-model review (Option A)

- The `Math.max(baseUrgency, chainUrgency)` block in `bt-ai-provider.ts` was **provably inert** — `chainUrgency` was non-zero only when `onCriticalPath === true`, at which moment the global plan's remaining segments are identical to the chain's `remainingRequiredMs` composition (chain + staircase + post-stairs + safetyBuffer), so with a shared slack window `chainUrgency === globalUrgency` always. Chain work is a strict subset of global work → `chainUrgency <= globalUrgency` unconditionally. Opus-4.8 flagged this; two other reviewers missed it. Escalated to human; sender chose "Option A: delete the inert block". The block and its dedicated test (whose author-comment already conceded the intended inequality could not be asserted) are gone. The `chainBeeline` and `chainSuppressionOverride` mechanisms — which do real work — are retained.

## Observe-before-done — Real headless artifacts (not lab-only)

**Real runtime**: The BT integration tests exercise `BehaviorTreeAI.poll(...)` against `createTestWorld(...)` scenarios — not a lab. They run the real BT decision path including `findProgressObjective` and `evaluateTacticalObjectiveOpportunities`. Each new tactical test asserts the observable pickup-suppression behavior via `getTacticalRunDebug().opportunities?.acceptedPickups`; each new `findProgressObjective` test asserts the observable Progress-vs-null decision under injected suppression state.

**Real headless (winrate-sweep)**: Ran `npm run ai:winrate-sweep` on all 14 pre-classified failing seeds twice (before + after the slice) and on the sword 1-20 zero-flip validation set. Artifacts in the session's `files/` folder — sample seed-level outputs:

- Pre-classified 14 seeds (sword 31/52/63, bow 2/60/63/64/82/84/88/100, bat 2/60/63):
  - Baseline (pre-slice): **0/14 wins**, 360s timeout each, dominant EXPLORE 66-91%.
  - Post-slice (with chainBeeline + chainSuppressionOverride): **still 0/14**, byte-identical dominant EXPLORE percentages.
- Zero-flip sword 1-20 sweep: 16/19 wins (12/17/18 fail with same pre-chain wedge signature; no seeds flip win→loss vs pre-slice).

**Interpretation** — This is what the slice was scoped to deliver, not evidence of failure to deliver: the 14 pre-classified seeds do not fail because of chain-timing; they wedge in **pre-chain** phases (tutorial / level-2 / shop / gold-farm) via `progressGoalSuppressedUntilFrame` **before** the Spell Broker chain becomes critical. `chainStatus.onCriticalPath` never flips true for those seeds, so the slice's mechanisms never arm. The slice is correct for its stated scope; the bottleneck lies elsewhere (see "Wedge-thrash finding" below), and Session 1 is coordinating the follow-up direction with that finding in hand.

## Wedge-thrash finding (relayed cross-session for follow-up)

The 14 pre-classified failing seeds share a signature that this slice cannot fix:

- Sources of suppression: `bt-ai-provider.ts` sets `progressGoalSuppressedUntilFrame = frame + PROGRESS_SUPPRESS_FRAMES` (360 frames ~= 6s @ 60fps) at ~L1648 (abandon-explore-frontier watchdog) and ~L1853 (quest-progress dwell watchdog).
- Suppression only affects fixed-position NPC/room targets. Entity-based goals (quest enemies, gold piles) are unaffected.
- BT root at L896 emits EXPLORE state for non-enemy progress targets, so "EXPLORE-dominant N%" metric **includes** blocked Progress-navigation — it does not mean "no progress attempt". A repeatedly re-suppressed position target looks like sustained EXPLORE.
- The seeds thrash on that loop before the Spell Broker chain becomes the critical path, so neither chain urgency nor the slice's suppression override arms.

Likely fixes belong to a follow-up (or PR #735's foundation): deadline-aware short-circuit on the dwell watchdog for pre-chain phases when global panic is high, or fixing the underlying navigation wedge to fixed room targets at consistent `worstWiggle` coordinates in each failing seed log.

## Session 1 integration surface (canonical for this slice)

- **Consumes**: existing `RunPlanSegment.travelMs` (PR #707).
- **Consumes** (future): if Session 1's `src/game/ai/objective-travel-estimate.ts` helper is later plumbed through segments, chain math benefits automatically — no code change required here.
- **Does NOT introduce**: pairwise travel-time matrix, node registry, `estimatedTravelMs` shape (owned by PR #735), or any parallel to `objective-travel-estimate.ts`.

## Rules compliance

- Deterministic: no `Math.random` / `Date.now` added.
- Layers: no `src/engine` imports from `src/game/ai`.
- No new `*System` requiring wiring (`npm run check:wired-systems` unaffected).
- Every mechanism unit-tested; both real-runtime (BT `.poll`) and pure-planner tests present.
- Rule #12: escalated the inert `Math.max` finding to the human rather than silently rationalizing or weakening tests; sender chose Option A.
- Rule #13: never bent gameplay to green cherry-picked seeds. Reported the honest 0/14 result and the pre-chain wedge diagnosis instead of tuning to the 14 seeds.

## Review harness (ledger valid 4🍎)

- `dual_plan_synthesis` — gpt-5.5 + gemini-3.1-pro-preview, judge claude-opus-4.8 (approved plan-a shape with plan-b risk mitigations).
- `plan_review` — gpt-5.4 xhigh (approve-with-extension: chain-target-only suppression override + deterministic tests + zero-flip validation).
- `code_review` — 2 rounds, claude-sonnet-4.6. Round 1: 1 Changes Requested (dead `!chainSuppressionOverride` clause on staircase-boss gate) + 4 non-blocking. Fixes: dropped dead clause, extracted 0.75 to named constant, added NOTE comment on detour flip. Round 2: clean.
- `multi_model_review` — gpt-5.5 + gemini-3.1-pro-preview + claude-opus-4.8; adjudicator claude-opus-4.7. Opus found substantive non-blocking design flaw (inert `Math.max`), escalated to human, sender chose Option A, cleanup applied.

## Validation

- `npm run test:unit -- tests/game/ai-run-planner.test.ts tests/game/behavior-tree-ai.test.ts`: 63/63 pass.
- `npm run verify:fast`: PASS.
- `VERIFY_FULL=1 npm run verify`: to be run before PR (in-progress at handoff time).
- `bash scripts/agent/lab-gate-check.sh`: to be run before PR.
- `npm run check:wired-systems`: to be run before PR (expected no-op — no new `*System`).

## Next follow-ups (not in this slice)

1. Pre-chain wedge fix — likely deadline-aware short-circuit on the dwell watchdog when global panic is high, symmetric to this slice's chain-scoped override. Session 1 coordinating.
2. Navigation-level fix for consistent `worstWiggle` coordinates on failing seeds (would benefit far more than any planner tuning).
3. Metric improvement — distinguish "EXPLORE-wandering" from "Progress-navigation to suppressed NPC" in headless dominant-state output so future diagnosis is faster.

## Guard telemetry

`files/guard-telemetry.jsonl` did not accumulate a session summary this cycle. If a future rerun produces one, run `npm run telemetry:capture -- floor1-spell-broker-chain-timing` per rule.
