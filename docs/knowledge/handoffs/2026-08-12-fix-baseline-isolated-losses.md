# Session Handoff: Fix Authoritative Baseline Isolated Route Failure

## Date

2026-08-12

## Persona

Game AI Engineer

## Systems touched

ai-pathfinding, ai-behavior-tree

## Apples

4🍎 estimated, 4🍎 actual (exact).

## Problem

Authoritative release baseline run `31561657791` at commit
`9eb2290273f526cfffb5da47fadde946b2bc6c78` recorded 583/600 Floor 1
victories. Five failures were isolated from shared seeds 52 and 69:

| Case              | Baseline outcome |
| ----------------- | ---------------- |
| bow-21            | timeout at 396s  |
| bow-35            | death at 159s    |
| baseball-bat-2    | death at 232s    |
| throwing-knife-29 | death at 235s    |
| fireball-25       | error at 114s    |

The release artifact exposed `fireball-25` only as `win:false`; exact local
reproduction revealed an `ObjectiveRoutePlannerError` rather than a combat loss.

## Root Cause

At frame 6843, ordinary combat movement left the live player's center at
`(280, 146.5427)`. Floor division mapped that point to blocked tile `(70,36)`
even though the player's 1.5ft-radius body still physically overlapped passable
tile `(69,36)`. A progression state-key update triggered strict objective-route
replanning. `findTilePath` correctly rejected the blocked start tile, so every
required goal appeared unreachable and the planner failed closed.

The other four isolated cases did not share this cause:

- `bow-21` stayed healthy but reached the final boss route too late.
- `bow-35` died while alternating wounded spacing and fetch progression.
- `throwing-knife-29` died while alternating low-health retreat and spell-broker
  travel.
- `baseball-bat-2` died during staircase boss lock-in amid 18 adds.

Those are distinct combat/strategy/timing slices, so this session made no
unjustified shared change and did not touch seed-52 or seed-69 causes.

## What Was Done

- Added an opt-in strict-oracle recovery contract for the true live-player
  location and physical body radius.
- When that configured start maps blocked, the oracle evaluates only cardinal
  passable tiles whose tile rectangles physically intersect the player body.
- Every eligible start runs through the unchanged strict A\* pathfinder; the
  oracle uses the minimum finite route cost. Diagonals, locked doors, barriers,
  unconfigured starts, and blocked goals remain strict failures.
- Wired the production Behavior Tree Floor 1 planner to pass the player's
  canonical `Size.radius`.
- Added focused oracle regressions and an exact real-headless
  `fireball-25` regression.

No weapon, damage, health, spawn, map-generation, or objective-balance values
changed.

## Real-Pipeline Evidence

Observed through the production `BehaviorTreeAI` and `runHeadless` pipeline with
23,760 frames and weapon personas enabled:

| Case        | Before                         | After                         |
| ----------- | ------------------------------ | ----------------------------- |
| fireball-25 | error at 114.05s, 47 kills     | victory at 240.02s, 111 kills |
| fireball-24 | healthy authoritative-baseline | victory at 242.75s, 98 kills  |
| fireball-26 | healthy authoritative-baseline | victory at 240.10s, 119 kills |

Two independent post-fix `fireball-25` reruns were byte-identical after removing
only the output `runAt` timestamp. Both reported 98.24% minimum HP and score
`1004220.7730639743`.

## Regression Coverage

- `tests/game/floor1-travel-oracle.test.ts` covers exact boundary recovery,
  multiple eligible starts, diagonal-only rejection, unconfigured starts, and
  locked-door strictness.
- `tests/headless/floor1-blocked-start-route-recovery.test.ts` runs the exact
  fireball seed 25 case through the real Behavior Tree/headless pipeline.

## Review

- Adversarial plan review (`gpt-5.4`) rejected the initial nearest-3x3 design and
  drove the explicit true-player, cardinal-overlap, all-candidate architecture.
- Single-model code review (`claude-sonnet-4.6`) found no concerns.
- Multi-model review (`gpt-5.3-codex`, `gemini-3.1-pro-preview`) found no
  validated concerns after `gpt-5.4` adjudication.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-08-12-fix-baseline-isolated-losses.review-ledger.json`.

## Validation

- Focused oracle suite: 15/15 passed.
- Exact real-headless regression: passed.
- `npm run typecheck`: passed.
- `npm run verify:fast`: passed, including 279 changed tests.
- `npm run check:wired-systems`: passed.

## Blockers

None for this coherent runtime fix. The four unrelated isolated combat/timing
failures require their own evidence-backed ownership and should not be folded
into this route-planner PR.
