# Handoff — Floor 1 Spell Broker chain timing (Slice 2) — STAND-DOWN, not landed

**Date**: 2026-07-03
**Branch**: `nalfeo-floor1-spell-broker-timing-guard` (preserved as salvage reference; NOT intended to land)
**PR**: [#737](https://github.com/nalfeo/Crawler/pull/737) — **CLOSED (stand-down)**. Reviewed code lives at commit `009807ce` on the closed PR's ref; recoverable via `gh pr checkout 737` or `git reset --hard 009807ce`. The branch itself was reset back to parent after this handoff was staged, so only these docs (handoff + apple metric + review ledger) live on the branch tip.
**Apple estimate → actual**: 4🍎 → 4🍎 spent (verdict: match on apples, no ship)
**Review ledger**: `docs/knowledge/review-ledgers/2026-07-03-floor1-spell-broker-chain-timing.review-ledger.json` (valid 4-apple, all 4 stages complete — dual-plan synthesis, plan review, code-review loop, multi-model review with adjudication). Kept committed on the branch as an audit trail.

## Decision (creator, 2026-07-03T15:53)

Do not land the chain-scoped filtering PR. The slice is honest about its scope but does not move the currently dominant Floor 1 failure class — 0/14 pre-classified failing seeds before **AND** after the change, byte-identical dominant EXPLORE% — because those seeds wedge in **pre-chain** phases before the chain's guard can arm. Session 1's PR #735 already landed the shared perfect-world travel-time API + canonical `criticalChainPhase` field, so the ecosystem gains from that slice regardless. The correct next PR — surfaced by this investigation — is the pre-boss suppression / fixed-position navigation wedge-thrash, not more chain-scoped urgency math.

The branch is preserved as a salvage reference for the reviewed patterns (chain-scoped urgency helper, `chainBeeline` tactical-tightening, `chainSuppressionOverride` for chain-critical progress goals) but is intentionally uncommitted-to-main.

## What this slice would have shipped (reviewed diff, unlanded)

Files on **closed PR #737 commit `009807ce`** (recoverable via `gh pr checkout 737` or `git reset --hard 009807ce`; not on any active branch tip):

- `src/game/ai/run-planner.ts` — added `RunPlanCriticalChain` union `'pre-chain'|'shop'|'spell-broker'|'staircase'|'post-stairs'|'other'`, `criticalChainPhase` on `RunPlanSegment` (Session 1 subsequently landed `RunPlanSegmentPhase` in PR #735 with an aligned taxonomy — see "Session 1 integration surface" below), `RunPlanChainStatus` interface, `spellBrokerChain: RunPlanChainStatus` on `Floor1RunPlan`, `computeSpellBrokerChainStatus` pure helper. NOTE comment documents the mid-chain-detour flip of `onCriticalPath`.
- `src/game/ai/bt-ai-provider.ts` (~+65 net after Option A cleanup):
  - `evaluateTacticalObjectiveOpportunities`: `chainBeeline` tightens `maxDetourFt = TRIVIAL` + `maxAccepted = 1` when `onCriticalPath && !complete && slackMs <= 0`.
  - `findProgressObjective`: fresh per-tick plan estimate + `chainSuppressionOverride` for 3 pre-completion chain-critical position targets (Broker, Slime Rat room, spell reward return) when `urgency >= CHAIN_SUPPRESSION_OVERRIDE_URGENCY`. Staircase-boss gate is post-`complete` so override is no-op-by-construction (documented in code).
- `src/game/ai/bt-ai-tuning.ts` — `CHAIN_SUPPRESSION_OVERRIDE_URGENCY = 0.75` with docstring.
- `tests/game/ai-run-planner.test.ts` — 7 planner unit tests in `describe('spell-broker chain breakdown')`.
- `tests/game/behavior-tree-ai.test.ts` — 5 BT integration tests exercising the real `BehaviorTreeAI.poll` path.
- `docs/knowledge/review-ledgers/2026-07-03-floor1-spell-broker-chain-timing.review-ledger.json` — valid 4-apple ledger.

The **Option A cleanup** (per rule #12) is baked in: the multi-model review discovered a `Math.max(baseUrgency, chainUrgency)` block was provably inert (chain `remainingRequiredMs` is a subset composition of the global plan's remaining segments with the same safety buffer, so `chainUrgency ≤ globalUrgency` unconditionally, with equality when it fires). Escalated to human; sender chose delete the block + dead test + misleading comment. The two mechanisms that do real work (`chainBeeline` and `chainSuppressionOverride`) are retained on the branch for salvage.

## Real headless results (honest, per rule #13)

- 14 pre-classified failing seeds (sword 31/52/63; bow 2/60/63/64/82/84/88/100; bat 2/60/63):
  - **Baseline pre-slice**: 0/14 wins, 360s timeout each, dominant EXPLORE 66-91%.
  - **Post-slice**: still 0/14, byte-identical dominant EXPLORE percentages.
- Zero-flip validation (sword 1-20): 16/19 wins; seeds 12/17/18 fail with the same pre-chain wedge signature (not slice-induced).

**Interpretation**: `chainStatus.onCriticalPath` never flips true on those seeds, so the slice's mechanisms never arm. The slice is correct for its stated scope; the bottleneck lies in pre-chain suppression, not chain timing.

Raw sweep artifacts (baseline / post / post2 / zeroflip logs + JSONs) live under the session-state `files/` directory alongside reviewer reports (`mm-review-{gpt5,gemini,opus}.txt`). Not committed to the repo (log files are forbidden by `.github/extensions/copilot-guards/guards/pr-preflight.mjs`).

## Wedge-thrash diagnosis — recommended next PR

The 14 pre-classified failing seeds share this signature:

- **Sources of suppression**: `bt-ai-provider.ts:~L1648` (abandon-explore-frontier watchdog) and `~L1853` (quest-progress dwell watchdog) set `progressGoalSuppressedUntilFrame = frame + PROGRESS_SUPPRESS_FRAMES` (360 frames ≈ 6s @ 60fps).
- Suppression only affects **fixed-position** NPC/room targets. Entity-based goals (quest enemies, gold piles) are unaffected.
- BT root at `:L896` emits **EXPLORE** state for non-enemy progress targets, so "EXPLORE-dominant N%" in headless output **includes** blocked Progress-navigation — the metric conflates true exploration with re-suppressed fixed-position targets.
- The seeds thrash on that loop repeatedly in **pre-chain** phases (tutorial / level-2 / shop / gold-farm) so chain urgency never arms.

**Recommended next PR (new Slice 2, replacing this stood-down one)**:

The next thin PR should focus on **suppression instrumentation before behavior change** so the wedge is measurable in headless output before anyone tries to fix it:

1. **Primary (this is the actual new Slice 2)**: add a `suppressedProgressNav`-equivalent event/label to the headless dominant-state accounting so the "EXPLORE-dominant N%" metric splits into "true EXPLORE wandering" vs "Progress-target suppression" (fixed-position NPC/room targets under `progressGoalSuppressedUntilFrame`). Emit whenever `bt-ai-provider.ts:~L1648` (abandon-explore-frontier watchdog) or `~L1853` (dwell watchdog) sets `progressGoalSuppressedUntilFrame`, tag with the current `criticalChainPhase` from PR #735 (`RunPlanSegmentPhase = 'detour' | 'pre-chain' | 'shop' | 'spell-broker' | 'staircase' | 'post-stairs' | 'other'`), and roll up per-run counts into `RunStats`. This is a pure-instrumentation PR — no policy change, no risk of regressing win rate — that turns the diagnosis of this handoff into a durable signal future PRs can gate on.
2. **Follow-up (a subsequent PR after instrumentation lands)**: deadline-aware short-circuit on the two watchdogs when global panic is high AND `criticalChainPhase === 'pre-chain'`, consuming `Floor1RunPlan.estimatedTravelMs` from #735. Only worth building once the instrumentation above proves the split is what we think it is.
3. **Root-cause investigation (parallel)**: verify whether the dwell watchdog's re-suppression on consistent `worstWiggle` coordinates is a navigation-layer oscillation (pathfinding wedge into a static obstacle). Session 1's `objective-travel-estimate.ts` provides the reference: if the pure travel estimate to a target says "reachable in X ms" but real navigation takes >>X or wedges, that's a signal to flag/reroute rather than suppress.
4. **This slice's chain-scoped filtering** is explicitly deferred as an **optional future consumer** of the suppression-instrumentation output, not the next PR. If instrumentation shows that chain-phase suppression is a distinct problem after the pre-chain wedge is fixed, then the salvage patterns from this branch (`computeSpellBrokerChainStatus`, `chainBeeline`, `chainSuppressionOverride`) can be re-litigated at that time.

## Session 1 integration surface (as shipped in PR #735)

Consume these primitives directly in Slice 3:

- `Floor1RunPlan.estimatedTravelMs: number` — top-level sum of remaining `segment.travelMs`.
- `RunPlanSegment.criticalChainPhase: RunPlanSegmentPhase` — shipped as `'detour' | 'pre-chain' | 'shop' | 'spell-broker' | 'staircase' | 'post-stairs' | 'other'`. Session 1 landed the same taxonomy this slice originally aligned around plus the `'other'` fallback for chain-scoped consumers, so a future wedge-thrash PR that layers on top can consume the shipped names without a rename cycle. (An earlier coordination message circulated a different aspirational taxonomy — `'tutorial' | 'merchant' | 'spell-slime-rat' | 'boss' | 'leave-floor'` — but that shape was never shipped; ignore it.)
- `src/game/ai/objective-travel-estimate.ts` — pure perfect-world travel-time helper with adapter-injected A\* + straight-line fallback.
- `CollapsePanicInput.playerToStairsTravelMs?` + `CollapsePanicProfile.travelBeelineActive` — stairs-specific panic wiring.

## Salvage patterns worth remembering

Even though this PR isn't landing, these patterns from `nalfeo-floor1-spell-broker-timing-guard` are validated by the 4-apple review harness and are drop-in reusable for Slice 3:

- **Chain-scoped urgency helper** (`computeSpellBrokerChainStatus` in `src/game/ai/run-planner.ts`) — generic pattern for deriving `remainingRequiredMs`/`slackMs`/`urgency` for any subset of segments picked by `criticalChainPhase`. Reusable for pre-chain suppression scoping.
- **`chainBeeline` tactical tightening** (`bt-ai-provider.ts` `evaluateTacticalObjectiveOpportunities`) — pattern for scoping `TACTICAL_OPPORTUNITY_TRIVIAL_DETOUR_FT` / `maxAccepted:1` to a specific phase + slack condition. Reusable for pre-chain phases.
- **Chain-scoped suppression override** (`bt-ai-provider.ts` `findProgressObjective`) — pattern for bypassing `progressGoalSuppressedUntilFrame` selectively on named fixed-position targets under a phase+urgency gate. This is exactly the shape Slice 3 needs, just with a different phase gate.
- **1-frame lag fix**: `this.lastRunPlan` is written AFTER BT tick, so any per-tick run-plan consumer inside the BT must re-estimate the plan (see the fresh `estimateCurrentRunPlan` call in `findProgressObjective`).

## Rules compliance

- Rule #10 (observe-before-done): real BT `.poll` integration tests + real headless `ai:winrate-sweep` on 14 seeds (both pre and post). Not lab-only.
- Rule #12 (never rationalize a flaw to go green): escalated the inert-`Math.max` finding to the human rather than reshaping tests to hide it; sender chose Option A; ledger records the escalation + resolution.
- Rule #13 (win-rate, not cherry-picked seeds): reported the honest 0/14 result; did not tune to those seeds; recommending the actual root cause fix as next PR.
- Rule #14 (review harness): 4-apple ledger valid; all 4 stages complete; kept committed on the branch even though the PR is closed.

## Guard telemetry

`files/guard-telemetry.jsonl` did not accumulate a session summary this cycle.
