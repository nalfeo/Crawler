# Handoff: Deterministic AI settlement-maintenance planner

## Date

2026-07-23

## Persona

Producer (self-triaged, single-session implementation with full apple-scaled review).

## Systems touched

ai-behavior-tree, inventory, quests, weapons, boss-rooms

## Apples

5 apples estimated, 5 apples actual. The change adds a new deterministic decision
module spanning four distinct legitimate-API integrations (achievements, boss
chests, equipment/Quartermaster, abilities), a bounded utility/cost planner with
explicit ordering, pipeline + lab wiring, and unit/regression coverage across
replay-determinism, affinity selection, affordability/capacity failure, stale
offers, ability-ordinal validity, idempotency, and bounded termination.

## Summary

- Added `src/game/ai/settlement-maintenance-planner.ts`: a deterministic,
  bounded AI planner that runs once per continuous settlement/safe-room visit
  and, exclusively through existing shared/atomic APIs:
  1. Claims any unlocked-but-unclaimed achievement rewards
     (`claimAchievementReward`).
  2. Opens/acknowledges any available/revealed boss chests (`openBossChest`,
     `acknowledgeBossChestReveal`).
  3. Runs a bounded greedy equipment-swap loop against
     `evaluateEquipmentLoadoutCandidates` (canonical stat/build affinity
     scoring against a fixed encounter fixture), purchasing from the
     Quartermaster only through `purchaseQuartermasterOffer` when a shop
     candidate wins, then equipping via `equipFromBag`.
  4. Fills any still-open active-ability slots with already-owned abilities
     via `configureOwnedActiveAbility`.
- The planner **never mutates gameplay state directly** — every state change
  flows through a pre-existing shared API that already enforces atomicity,
  exact-once claiming, and fail-closed validation. No reward generation
  happens at claim time; claims only unlock rewards that content generation
  already produced.
- Bounded/deterministic by construction: `EQUIPMENT_LOOP_CANDIDATE_CAP = 8`
  caps the equipment loop; a this-visit `blacklistedInstanceIds` Set lets a
  failed purchase/equip attempt (stale offer, insufficient funds, full bag)
  fall through to the next-ranked candidate instead of aborting the whole
  loop; a defer-then-retry-once pattern gives achievement/chest claims a
  second attempt within the same visit before giving up.
- A "run once per opportunity" latch (added during plan review) prevents the
  planner from re-running every frame while the player remains in the
  settlement.
- Every decision and skip is recorded in
  `SettlementMaintenanceResult.decisions` telemetry, explaining the reason
  (utility score, affordability failure, capacity failure, stale offer,
  already-claimed, ability slot full, etc.) so a replay is fully inspectable
  and assertable.
- Explicitly excludes travel-return routing to reach the settlement (a later,
  dependent slice) — this planner only acts while the player is already
  physically inside a `RoomRole.SAFE` room.
- Added `src/labs/settlement-maintenance-planner-lab/index.ts` (a
  "Run Planner" button lab exercising the full flow against a real Floor 2
  settlement boot) and wired the planner into the real headless/AI pipeline
  (`src/game/ai/headless-runner.ts`).
- Fixed a related lab-only bug found during a code-review false-positive
  investigation: `settlement-maintenance-planner-lab` never called
  `safeRoomSystem(world)`, silently no-oping the "Run Planner" button.

## Runtime evidence

`tests/game/settlement-maintenance-planner-safe-context.test.ts` boots a real
Floor 2 settlement via `initializeFloor2Scenario` /
`initializeFloor2Settlement` (the actual game boot sequence, not a synthetic
fixture), confirms the settlement room is retagged `RoomRole.SAFE` before the
player can reach it, then runs the planner end-to-end and observes real
equipment being equipped in the real `world` ECS state — proving the module
is reachable and functional in the real headless pipeline, not just in
isolation.

## Validation

- `npx tsc --noEmit`: clean.
- `tests/game/settlement-maintenance-planner.test.ts` +
  `tests/game/settlement-maintenance-planner-safe-context.test.ts`: 18/18
  passing (deterministic replay, affinity selection, affordability/capacity
  failures, stale offers, ability-ordinal validity, idempotency/no-duplicate
  claims, bounded termination, blacklist-and-continue on partial equipment
  failure).
- `npm run check:wired-systems`: 0 blocking findings.
- `npm run verify:fast`: passed.
- Review ledger validation: passed
  (`npm run review:ledger -- validate` → valid 5-apple ledger).

## Review

- Adversarial plan review (`gpt-5.6-terra`, rubber-duck): APPROVE WITH
  CHANGES; 2 alternatives considered; `plan_divergence: minor`; 4 concerns
  (2 blocking, 2 non-blocking), all 4 resolved — renamed
  `EQUIPMENT_ACTION_CAP` → `EQUIPMENT_LOOP_CANDIDATE_CAP`, implemented the
  defer-then-retry-once claim pattern, added the run-once-per-visit latch,
  and rewrote the equipment loop to blacklist-and-continue past a failing
  candidate instead of aborting.
- Code review (single round): 1 Critical finding investigated and resolved
  as a false positive as originally raised — `isInSafeContext`/
  `RoomRole.SAFE` gating does pass for a real settlement room because
  `prepareSettlementMapAndPlacement` retags it before the player can reach
  it; converted the investigation into the permanent
  `settlement-maintenance-planner-safe-context.test.ts` regression test and
  fixed the related lab bug (lab never called `safeRoomSystem`).
- Multi-model review (`claude-sonnet-4.6`, `gpt-5.3-codex`,
  `gemini-3.1-pro-preview`, `gpt-5.4` security), self-adjudicated in-session:
  2 concerns raised — one stale/already-fixed (a mid-edit test snapshot the
  agent observed before an in-flight order-agnostic rewrite landed) and one
  ledger-completeness gap (this document + the ledger stages themselves),
  both resolved.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-23-ai-settlement-maintenance-planner.review-ledger.json`

## Follow-up

Publish a ready PR against `main`, arm squash auto-merge, shepherd CI/review
findings, and report the PR number, final head SHA, and verified merge SHA to
the parent session. The next dependent slice implements travel-return routing
so the AI can navigate back to the settlement to trigger this planner
autonomously mid-run.
