# Handoff — AI On-Path Loot Pickup Detours

**Date:** 2026-06-27
**Session:** ai-pickup-detours
**Persona:** Systems Engineer
**Apple estimate:** 🍎🍎🍎 | **Actual:** 🍎🍎🍎 | **Verdict:** 🎯 exact

## Problem

The AI runner (`BehaviorTreeAI`) ignored loot/xp/gold sitting right next to its
travel path while exploring or navigating to quest objectives. The user's rule:
**"if there is loot within 5' of my path and I am not actively fighting or
dodging enemies, make the slight detour to grab it."**

## Root Cause

Track B's `OpportunisticCollect` layer was effectively dead for this case:

1. `collectPullWeight` defaulted to **0.0**, so the loot-pull vector was
   multiplied to nothing in `poll()`.
2. `OpportunisticCollect` early-returned FAILURE during quest navigation
   (`EXPLORE && targetEid !== null`), so no pull was even computed while heading
   to quest stuff.

Both were deliberate (handoff `2026-06-23-parallel-bt-opportunistic-layer.md`): a
naive **omnidirectional** pull toward any loot within 120px biased the AI's net
trajectory toward loot-dense = enemy-dense zones, caused 2–3× more fights, and
blew the 300s headless Floor-1 clear budget — even at weight 0.15.

## The Fix — forward-corridor "on-path detour"

Implements the player's rule literally. The detour now pulls toward loot only
when it is **ahead** of the player along the current heading **and within 5 ft
(40px) perpendicular of that path ray** — a narrow forward corridor instead of an
omnidirectional grab. This is what structurally prevents the old regression: loot
behind or far to the side of the travel direction is ignored, so the pull can
never systematically drift the net trajectory toward off-path enemy clusters.

- **Heading reference:** previous-frame smoothed output (`smoothMoveX/Y`). Skipped
  when effectively stationary (`DETOUR_MIN_HEADING_MAGNITUDE`).
- **Forward gate:** `dot(player→loot, heading) >= 0` (must be ahead).
- **Corridor gate:** perpendicular distance `sqrt(d² − forward²) <=
PATH_CORRIDOR_HALF_WIDTH_PX` (`ftToPx(5)` = 40px).
- **Forward cap:** total distance `< opportunisticGrabRadius` (120px) keeps it slight.
- **"not fighting or dodging":** suppressed in ENGAGE/RETREAT, and when a dodge
  impulse is active this frame. Dodge now ticks **before** Collect in the Track B
  parallel so Collect can see the in-progress dodge. Also still skipped in COLLECT
  (Track A already collecting) and INTERACT (brief NPC final-approach — the long
  travel toward an NPC happens in EXPLORE and IS eligible).
- **Allowed during quest nav** (`EXPLORE` with a non-null target) — the actual fix
  for "going to do quest stuff".
- `collectPullWeight` default 0.0 → **0.5**.
- **Decoupled the enemy-farm pull** onto its own `farmPullWeight` (default **0.0**,
  dormant) and its own `farmPullX/Y` vector, so re-enabling loot detours never
  silently re-enables enemy farming (the bigger budget risk, and not requested).

## Files Changed

| File                                  | Change                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/game/ai/types.ts`                | Reworked `collectPullWeight` doc; added `farmPullWeight` field                                                                                                  |
| `src/game/ai/bt-ai-provider.ts`       | Corridor-gated `OpportunisticCollect`; dodge-before-collect reorder + dodge gate; decoupled farm vector/weight; `collectPullWeight` 0→0.5; debug + reset wiring |
| `src/labs/parallel-bt-lab/index.ts`   | Split Track B panel into separate "Collect (loot) detour" / "Farm (enemy) pull" lines                                                                           |
| `tests/game/behavior-tree-ai.test.ts` | +5 tests (in-corridor pull, behind ignored, off-corridor ignored, ENGAGE suppression, farm dormant-by-default)                                                  |

## Validation

- `npm run verify:fast` ✓ (typecheck + lint + 81 unit tests)
- `npm run verify` ✓ (format, knip, coverage, integration, **headless Floor 1 gate
  — 44 tests, all 9 seed×weapon combos clear < 300s, no regression**, build)
- New unit tests use the Floor-1 quest-nav scenario (`pollQuestNavHeading` helper)
  so Track A stays in Progress nav (not COLLECT) and the detour layer is the thing
  under test; the heading is measured from `input.moveX/moveY` after one poll and
  loot is placed relative to it (no movement system runs in unit tests, so the
  player is static between polls).

## Notes for Next Agent

- The detour fires from poll **2** onward: poll 1 establishes the heading
  (`smoothMoveX/Y` starts at 0), poll 2 is the first with a usable path ray.
- `farmPullWeight` is intentionally dormant. If you ever enable it, **re-run
  `npm run test:headless`** — enemy-seeking during idle wander is the known
  budget-buster.
- Tuning knobs if a future change pressures the budget: lower `collectPullWeight`
  (0.5 → 0.35) or shrink `PATH_CORRIDOR_HALF_WIDTH_PX`. The corridor model is
  inherently budget-safe (forward-only, narrow), so 0.5 passed with margin.
- No `files/guard-telemetry.jsonl` present this session, so no guard-telemetry
  section to paste.

## Apples

Estimated 🍎🍎🍎, actual 🍎🍎🍎 (exact). Tuning of an existing sub-system across
3 source files + 5 regression tests, no new ECS system and no ADR — squarely
Medium. The mid-task simplification (angular cone → 5 ft corridor) replaced rather
than expanded the design, so scope held.
