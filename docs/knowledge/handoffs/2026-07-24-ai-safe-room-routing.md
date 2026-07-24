# Handoff: Deterministic AI safe-room/settlement return routing

## Date

2026-07-24

## Persona

Producer (self-triaged, single-session implementation with full apple-scaled review).

## Systems touched

ai-behavior-tree, ai-pathfinding, ai-combat-balance, quests, inventory

## Apples

4 apples estimated, 4 apples actual. A latched optional route goal integrated into
the real BT/headless pathing pipeline, deterministic expected-gain-vs-cost utility
with hysteresis/cooldown state machine, explicit abandon/replan conditions,
telemetry, and full property/unit/integration/headless coverage.

## Summary

Builds on the merged AI maintenance planner (PR #1862,
`2a216026f52d0bf722e9955f11c32dbaa2d2c013`), which runs the legitimate
achievement/chest/equipment/ability maintenance flow **while already inside** a
safe room. This slice adds the missing piece: **deciding whether to travel back
to a safe room/settlement at all**, and physically getting there via real
pathing.

- Added `src/game/ai/settlement-return-router.ts`: a deterministic per-world
  latched state machine (`idle -> armed -> traveling -> arrived -> resuming ->
cooldown`, with `aborted-danger` / `aborted-unreachable` exits) driven by
  `updateSettlementReturnIntent(world, ai, ...)`. Utility is computed as
  `expectedGain - travelCost - riskCost - opportunityCost` against
  `DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS`; a hysteresis band plus a
  `lastServicedFingerprint` gate prevent re-triggering for the same
  already-serviced opportunity; `SETTLEMENT_RETURN_SERVICE_COOLDOWN_FRAMES`
  (600), `SETTLEMENT_RETURN_DANGER_COOLDOWN_FRAMES` (900 — intentionally
  longer than the service cooldown as a defense-in-depth anti-oscillation
  buffer), and `SETTLEMENT_RETURN_UNREACHABLE_COOLDOWN_FRAMES` (600) gate
  re-arming after each exit path. Every state transition emits a `'control'`
  `SimEvent` (`settlement-return: <status> — <reason>`) explaining the
  decision.
- Added `isSettlementReturnRoutingEnabled(world)`: a cheap public read used to
  skip all per-poll precompute when the feature is disabled (the default).
- Wired into `src/game/ai/bt-ai-provider.ts`'s pre-tick poll: gated behind
  `isSettlementReturnRoutingEnabled`, resolves the real Floor 2 settlement
  anchor, real nearest-enemy/engage-radius danger signal, and the shared
  `progressGoalSuppressedUntilFrame` unreachable signal (the same mechanism
  every other mandatory Progress branch already uses — no new "walled off"
  concept). When `armed`/`traveling`, the router's target **wins the BT's
  route decision** as an optional goal, but yields immediately (same tick)
  to focused-hunt combat priorities the instant real danger appears, and
  yields to the mandatory Progress branch's own unreachable signal.
- Wired into `src/game/ai/headless-runner.ts` /
  `headless-runner-cli-lib.ts` / `headless-runner-cli.ts`: new
  `settlementReturnRouting` boolean option (default `false`) and
  `--settlement-return-routing` CLI flag.
- **No teleport, no direct state mutation, no reward generation, no
  `Math.random`/`Date.now`** — the router only ever changes the AI's
  _movement target_; all actual settlement-visit effects still flow through
  the pre-existing, already-atomic `settlement-maintenance-planner.ts` APIs
  from PR #1862.

## Runtime evidence

Observed the real headless pipeline (`headless-runner-cli.ts`, Floor 2, seed
92, `--settlement-return-routing`) organically trigger multiple full
`armed -> traveling -> arrived -> resuming -> cooldown` maintenance cycles
interleaved with `aborted-danger` interruptions during real combat, proving
the feature is reachable and functional against real gameplay, not just in a
lab or synthetic fixture.

`tests/headless/settlement-return-routing.test.ts` (7 tests) additionally
proves, against the real headless pipeline: deterministic replay (identical
telemetry across two runs of the same seed/config), positive-utility
trigger + real pathing + maintenance execution + resume + bounded round trip,
negative-utility no-trigger, default-off regression guard (zero telemetry
when the flag is omitted), unreachable-abort via the shared
progress-suppression signal, danger-abort via a real inert threat entity
(preserving combat priority), and a false-transition guard proving the
router never claims credit for the _mandatory_ first-visit settlement
arrival that already exists independent of this feature.

## Validation

- `npx tsc --noEmit -p tsconfig.json`: clean.
- `npx eslint` on all changed files: clean.
- `tests/game/settlement-return-router.test.ts` +
  `tests/game/behavior-tree-ai.test.ts` +
  `tests/unit/ai/headless-runner-cli-lib.test.ts`: 151/151 passing
  (deterministic replay, positive/negative utility, hysteresis band,
  fingerprint anti-retrigger, cooldown gating, unreachable/danger abort +
  recovery, combat-spacing/priority identity preservation, disable
  fully resets state).
- `tests/headless/settlement-return-routing.test.ts`: 7/7 passing.
- `npm run verify:fast`: passed (296 tests).
- `npm run review:ledger -- validate`: valid 4-apple ledger.

## Review

- Adversarial plan review (`gpt-5.4`, high reasoning, 3 rounds): 13 concerns
  raised across rounds, all resolved; `plan_divergence: major_fork` (the
  reviewer's alternative — unconditional pre-tick update instead of
  branch-gated update — was adopted, mirroring but stricter than the
  existing `merchantWeaponIntent` pre/post-tick split).
- Code review (2 rounds, `claude-sonnet-4.6`): round 1 found and fixed 1
  real bug (`configureSettlementReturnRouting` not fully resetting state on
  disable — added a regression test); round 2 clean.
- Multi-model review (2 rounds): round 1 (`gpt-5.3-codex`,
  `gemini-3.1-pro-preview`, `gpt-5.4` security) found 1 valid Medium
  finding (unconditional per-poll threat-scan precompute even when the
  feature is disabled) — fixed via `isSettlementReturnRoutingEnabled`
  gating, adjudicated VALID+RESOLVED by a dedicated `gpt-5.4` adjudicator.
  Round 2 (`gpt-5.3-codex`, `gemini-3.1-pro-preview` re-review) confirmed
  round 1 resolved and found 1 valid High finding: the danger cooldown
  constant (300 frames) was shorter than the service cooldown (600),
  contradicting its own documented anti-oscillation invariant — fixed by
  raising it to 900. That fix exposed a latent test-timing issue in the
  headless happy-path test (forcing eligibility at frame 1 meant every
  attempt was intercepted by organic Floor 2 combat before reaching the
  settlement — confirmed deterministic and reproducible even at 30000
  frames, not flaky luck); fixed by seeding opportunity right after the
  mandatory first-visit settlement arrival instead of at frame 1, mirroring
  the sibling false-transition-guard test's own documented finding that
  this seed's AI beelines to the settlement as its first EXPLORE target.
  Terminal round 2 clean (2-round cap).
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-24-ai-safe-room-routing.review-ledger.json`.

## Follow-up

Publish a ready PR against `main`, arm squash auto-merge, shepherd any CI/
review findings, verify the merged SHA, and detach per Producer policy.
Broad (>10 run) sweeps to further tune the utility/hysteresis constants
against Floor 1/2 balance remain GitHub-backed and are explicitly out of
scope for this slice.
