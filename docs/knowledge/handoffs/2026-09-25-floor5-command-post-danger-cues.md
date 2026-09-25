# Session Handoff: Floor 5 Command Post danger cues

## Date

2026-09-25

## Persona

Producer coordinating the bounded Slice 7 presentation follow-up.

## Systems touched

Floor 5 scenario HUD presentation, generic scenario HUD cue bridge, Floor 5
headless presentation coverage, and Floor 5 real-scene observation.

## Recommendation and scope

**Recommended.** The post-#4659/#4712 runtime baseline already makes objectives
and their pressure playable. The next direct dependency-complete gap is the
existing Slice 7 requirement for a Command Post base-danger cue: the post is
the floor's terminal loss condition but previously rendered only a number.

This slice adds no ECS system, art, pressure tuning, movement, combat, or RNG.
It reuses the generic scenario-HUD audio/VFX seam. A damaged post says
"under attack — defend the line"; a post at or below one quarter health says
"critical — return to the line." Healthy and terminal states produce no cue.

## Planning contract

Hard gate: identical Floor 5 state yields identical non-color-only warning text
and stable cue IDs; a healthy post has none; the existing real MainGameScene
probe observes the warning audio/VFX labels and HUD layout.

Ranked tiebreakers: deterministic behavior, real/headless evidence, then
minimal scope. The Producer CLI classified the explicit contract as unclear,
so it was not used as proof of readiness. No new architectural decision is
introduced; the existing `ScenarioHudSnapshot` bridge is sufficient.

## Validation

- `npm test -- tests/unit/floor5-presentation.test.ts tests/headless/floor5-siege-foundation.test.ts`
  — passed (22 tests). The added headless real-pipeline case applies ordinary
  damage to the live Command Post and observes the warning projection.
- Focused real scene: `vitest run --project e2e-game
tests/e2e/main-game-scene-floor5-combat.test.ts -t sword` — passed (1 test).
  It observes the damaged-post text plus both generic HUD cue labels in
  `MainGameScene`.
- `tsc --noEmit` and focused ESLint passed.
- `verify:fast`, `verify:pr-prereqs`, and fresh Ducky review are required
  before publication; record their final results here.

## Before / after observation

- **Before:** a damaged Command Post changed only its HP text; Floor 5 emitted
  no scenario HUD cues (`cues: []`) for its sole immediate loss condition.
- **After:** warning and critical health states expose explicit text and stable
  one-shot audio/VFX cue identities through the real shared scene bridge.

## Systems and dependency notes

- This is the unblocked base-danger portion of epic Slice 7 (`FR9.2`), after
  the runtime pressure/objective work in PRs #4659 and #4712.
- The generic `MainGameScene` cue player deduplicates by cue ID, so warning and
  critical cues use separate stable IDs and cannot replay every HUD frame.
