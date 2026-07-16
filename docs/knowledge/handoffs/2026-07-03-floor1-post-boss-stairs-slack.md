# Floor 1 post-boss stairs slack + shared perfect-world travel-time API

Slice-1 follow-up to PR #707 (time-aware Floor 1 AI). Builds the shared perfect-world travel-time infrastructure the AI needs to feed player→objective travel estimates into the existing collapse-panic beeline threshold, and phase-gates a post-boss stairs beeline escalation on top of it.

## Systems touched

enemies

## Apple estimate

- Declared: **3🍎**
- Actual: **3🍎**
- Verdict: **on-target** — three coupled changes (planner data, panic input, wiring) with a plan review + code review loop; unit-tested at the boundary; ~half a day of active work.

Metric file: `docs/knowledge/metrics/apples/2026-07-03-floor1-post-boss-stairs-slack.json`.

## Summary

The AI has perfect world knowledge and must keep deterministic estimates of travel time between all known Floor 1 quest objective nodes and feed them into the time-based panic/prioritization system (not debug-only). This slice ships that infrastructure and wires the largest missing link — player → staircase — into `computeCollapsePanicProfile`:

- **`Floor1RunPlan.estimatedTravelMs`** — new top-level chain-travel sum on the existing run plan. Sum of every remaining `RunPlanSegment.travelMs`. Non-behavioral (data-only) and compatible with the sister session's chain-scoped consumer, which reads segments generically.
- **`estimateObjectiveTravelMs`** — new pure module (`src/game/ai/objective-travel-estimate.ts`) that returns A*-path-aware travel time between two world-space points when adapters are supplied, or straight-line × wall-safety factor + additive buffer when they are not. Deterministic, injected adapters (`worldToTile`, `findTilePath`, `tileSizeFt`), fully unit-tested with 6 cases (fallback, A* path, empty path, determinism, single-tile zero, fallback strictly larger than straight-line).
- **`CollapsePanicProfile.playerToStairsTravelMs` + `.travelBeelineActive`** — panic input takes an optional deterministic player → stairs travel estimate. When present AND the run is in the `staircaseUnlocked && !staircaseDiscovered` phase, the beeline threshold escalates to `max(60_000, travelMs + PANIC_STAIRS_TRAVEL_SAFETY_MS)`. The 120s panic ramp window shifts up with it so pressure still ramps in over 2 minutes, never suddenly at `t = threshold`. Non-finite / negative inputs are rejected. Legacy callers that omit the field see identical behavior. New `travelBeelineActive` bit is set only when the escalation is what actually drove the beeline (vs. the legacy fixed-60s path).
- **`BehaviorTreeAI.refreshPlayerToStairsTravelEstimate`** — throttled A\* travel cache (15 BT-tick frame throttle or player-tile-change refresh, whichever is sooner). Called in `poll()` right after `refreshDoorNavigation` so `groundPathOptions` is already fresh; feeds into `getCollapsePanicProfile`. Deterministic (`world.frameCount` is deterministic). Only runs during the post-unlock / pre-discovery phase; returns to null otherwise. Cache cleared in `reset()`.

## Files touched

- `src/game/ai/run-planner.ts` — added `estimatedTravelMs` field to `Floor1RunPlan` + reduce.
- `src/game/ai/objective-travel-estimate.ts` — new pure helper module.
- `src/game/ai/bt-ai-provider.ts` — extended `CollapsePanicInput` / `CollapsePanicProfile`; new `refreshPlayerToStairsTravelEstimate` + fields; wired into `poll()`; reset() cleanup; imports.
- `src/game/ai/bt-ai-tuning.ts` — `PANIC_STAIRS_TRAVEL_SAFETY_MS`, `OBJECTIVE_TRAVEL_WALL_SAFETY_FACTOR`, `OBJECTIVE_TRAVEL_WALL_SAFETY_BUFFER_MS`, `OBJECTIVE_TRAVEL_ASTAR_REFRESH_TICKS`.
- `tests/game/ai-run-planner.test.ts` — `estimatedTravelMs` sum + cleared-chain zero.
- `tests/game/objective-travel-estimate.test.ts` — new file, 6 cases.
- `tests/unit/ai-collapse-panic-profile.test.ts` — new `travel-time beeline threshold escalation` describe block: high-travel escalates, pre-unlock doesn't, post-discovery doesn't, non-finite/negative rejected, sub-threshold doesn't flip `travelBeelineActive`, legacy behavior when omitted; plus update to the pre-existing null-input shape assertion.
- `docs/knowledge/review-ledgers/2026-07-03-floor1-post-boss-stairs-slack.review-ledger.json` — 3-apple ledger with plan_review + code_review stages recorded.

## Verification

- `npm run typecheck` — green.
- `npm run verify:fast` — green (9 files / 96 tests).
- `npm run verify` (full, sans `VERIFY_FULL`) — green through step 7 (unit + integration + test:guards + PR prereq check). Step 8 (headless Floor 1 gate) is deferred to CI per repo policy.
- Unit tests directly touched: 26 pass across `tests/unit/ai-collapse-panic-profile.test.ts` + `tests/game/ai-run-planner.test.ts` + `tests/game/objective-travel-estimate.test.ts`.
- Broad headless sweep (all 3 Floor 1 weapons × seeds 1–40, 120 runs total):
  - sword 32/40 = 80.0%; bow 31/40 = 77.5%; baseball-bat 30/40 = 75.0%; **overall 93/120 = 77.5%**.
  - **No regression** vs. baseline: verified by stash-and-rerun on sword seeds 1–8. Identical pass/fail set, identical wiggle signatures on the single failing seed.
- **Honest scope note on the target failure class**: the "final boss / stairs route" bucket (24/60 branch failures cited in the task) reported sword-36 completing the boss at 296.9s then timing out at 360s before stairs completion. That failure mode is _not_ currently reproducible on `main` at bb5e18f3. Every current sword-36 / sword-{12,17,24,60,76,84,100} failure is now dominated by pre-boss `EXPLORE` state (84–91% dominance) with high kill counts but the run stuck earlier in the objective chain — the AI does not reach the boss at all. Confirmed by pre-change stash-and-rerun: sword-36 fails identically (208 kills, EXPLORE 87.7%, 2s wiggle @ (525,66)) with and without this change. My change is a strict phase-gated no-op on pre-unlock seeds by design — it activates only after `staircaseUnlocked && !staircaseDiscovered`. So this slice's runtime win-count delta on the current failure set is 0/24 by construction; the value delivered is the infrastructure the human-stated requirement demands (deterministic perfect-world travel-time estimator, chain-total travel field, phase-gated panic escalation, unit-tested at boundary) plus the shared surface the sister session's chain-scoped consumer can slot per-segment perfect-knowledge sources underneath.

## Verify observed behavior (real pipeline, not lab)

- `estimateFloor1RunPlan` is called by the real headless runner via `BehaviorTreeAI.poll` → `computeTravelSteering` → `estimateCurrentRunPlan` (existing wiring); new `estimatedTravelMs` field flows through it without any behavior branch on it in this slice.
- `refreshPlayerToStairsTravelEstimate` is wired into `BehaviorTreeAI.poll()` (between `refreshDoorNavigation` and `tree.tick`), which is the real BT AI poll consumed by `headless-runner.ts` and `MainGameScene`. Confirmed by grep + the winrate-sweep sample runs above (which exercise the real headless runner). No lab-only validation.

## Cross-session compatibility

- The sister session (chain-scoped filtering) reads segments generically via `RunPlanSegment.travelMs`. This slice does **not** change segment shape or per-segment values; it only adds a top-level chain sum. Their consumer keeps working unchanged.
- The `estimateObjectiveTravelMs` helper is general — it accepts any (from, to) world-space pair. Their per-segment perfect-knowledge source can slot underneath by re-using it when they later replace their current straight-line segment travel with A\*-path-aware travel.

## Unresolved issues / recommended next steps

- **Pre-boss `EXPLORE` stall** is now the dominant Floor 1 failure class (27/120 across sword/bow/bat sweeps). Investigating the root cause is out of slice-1 scope but critical for the 90% win-rate target. Recommend a follow-up slice: instrument `EXPLORE` dominant runs to identify which quest node the AI is stuck near (kills 200+ but level 4–8 → probably grinding respawns instead of chaining objectives).
- Extending the perfect-world travel-time surface to _all_ Floor 1 objective node pairs (welcome → shop, shop → merchant, shop → Spell Broker, etc.) — this slice only wired player → stairs into panic. The helper is general and ready; hooking each edge into the run-planner segment travel is the natural next step.
- One test-run seed (bow-23 = death via retreat @ 248s) may be a separate defensive-loop bug; also out of slice-1 scope.
