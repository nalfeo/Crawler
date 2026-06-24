# Session Handoff: PR 269 review comments + next-step floor AI improvements

## Date

2026-06-24

## Persona(s) adopted

**Producer** — multi-layer task spanning review-comment fixes, a bug fix, and a
new AI feature; no single specialist owned all three.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — four discrete deliverables, each bounded and measured:
schema fix (trivial), defensive test (1 test), fetch-item eid fix (1 path
change), time-phased priorities (1 constant + 3 block rewrites).

Hello kitties: 4/5 = 0.80 🎀

## What Was Done

Addressed all open review threads on PR 269 and implemented two of the three
handoff "What's Next" items. All changes confined to
`src/game/ai/bt-ai-provider.ts`, `tests/game/behavior-tree-ai.test.ts`, and
docs.

### 1. Apple metrics JSON schema fix (review comment)

`docs/knowledge/metrics/apples/2026-06-24-floor1-ai-micro-spacing-winrate.json`
used non-canonical field names (`slug/estimated/actual`) and lacked `delta` and
`hello_kitties`. Aligned to the `AppleEntry` interface in
`scripts/agent/docs/apple-calibration.ts`.

### 2. Defensive-spacing unit test (review comment)

Added `expands orbit to defensive wide-band when player HP drops below 40%` to
`tests/game/behavior-tree-ai.test.ts`. Uses a CHASE enemy with
`attackRange = 40px` (so `safeOrbit = 54px`):

- Full health: `safeOrbitCap = outerOrbit = 50px`, 54 > 50 → no expansion → target ≈53px from enemy
- Low health (30%): `safeOrbitCap = strikeGate = 60px`, 54 ≤ 60 → orbit bumps to 54 → target ≈57px

Asserts `lowDist > fullDist + 3` to prove clear separation.

### 3. Fetch-item pickup deadlock fix (handoff next step)

Root cause: `findProgressObjective`'s `awaiting-prize` path navigated to
`objective.questItemPos` with `eid = -1`. On the final approach the AI would
reach within `DIRECT_MOVE_EPSILON_PX = 10px` and stop — but without the entity
reference the collect watchdogs couldn't blacklist or re-route, and the AI
oscillated forever.

Fix: look up `world.floor1.questItemEid`, validate it exists, read its live
pixel position, and pass the eid to `createProgressTarget`. With the eid set:

- `CLOSE_APPROACH_DIRECT_PX` still fires at 48px for direct-slide navigation
- Watchdogs can track progress toward the entity, not an anonymous tile center
- Falls back to fixed `questItemPos` if entity is gone (already collected)

Covered by new unit test `routes fetch-item navigation through the DroppedItem
entity to avoid tile-A* wiggle`.

### 4. Time-phased floor priorities (handoff next step)

Added `LATE_FLOOR_CLOCK_FRACTION = 0.75`. When `world.elapsedMs /
objective.deadlineMs >= 0.75` (i.e. 75 s left of the 300 s budget), the three
merchant sub-quest branches fall through instead of returning early:

- `not-met`: skip seeking shopkeeper → falls through to boss path
- `awaiting-prize`: skip fetch-item / return-prize → falls through to boss path
- `ready-to-buy`: skip gold-farming / charm-buy → falls through to boss path

This cuts over-farming timeouts where the AI grinds to a high level but never
advances to the staircase.

Covered by new unit test `skips the merchant sub-quest and heads to the Spell
Broker when floor clock is urgent`.

## What's Next

The third handoff item (stuck-early timeouts, ~8 seeds at lvl 0) is the
remaining open gap:

- **Stuck-early timeouts (~8 seeds, e.g. 36 at lvl 0).** The AI deadlocks at
  spawn — never engages any enemy. Likely an Explore/door-open path wedge.
  Diagnosis requires running the parallel 50-seed eval harness to identify
  which specific seeds fail and capturing the AI reason log for the first 60s
  of each stuck run.
- **Optional: standoff 40px.** A 4px tighter absolute bow standoff might squeeze
  a few more bow wins — low risk but low return.

With the fetch-item fix and clock-urgency applied, re-running the harness should
show a meaningful lift from 52% toward the 75%+ target before tackling
navigation deadlocks.

## Blockers

None. All tests pass (unit 1677, integration 28, headless seed-15 gate 4; build green).

## Branch State

- Branch: `nalfeo-legendary-fishstick`
- All tests passing: yes (unit + game: 1677 passed, integration + headless: 32 passed)
- PR: #269 (existing, updated)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no telemetry section to paste.

## Test Results

- `npm run verify:fast` → ✅ passed (typecheck + lint + tests)
- `npx vitest run --project unit --project game --project integration --project headless` → **1677 passed** (164 files)
- Parallel validation: Code review ✅ · CodeQL 0 alerts ✅

## Key Decisions Made

- **Do NOT use `return null` inside clock-urgency shopkeeper blocks** — must
  use `if (!clockUrgent) { return ...; }` (fall-through) so the function
  continues to the boss-battle path. Using `return null` early exits the entire
  `findProgressObjective` and causes the AI to idle-explore when it should be
  heading to the Spell Broker / boss.
- **Apple metrics `summary` field is NOT canonical** — the `AppleEntry` interface
  in `apple-calibration.ts` has 7 fields (no `summary`); the Copilot reviewer's
  comment about `summary` being required was a false positive.
