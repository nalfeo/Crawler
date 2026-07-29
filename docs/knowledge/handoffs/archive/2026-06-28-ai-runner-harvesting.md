# Session Handoff: AI Runner gathers harvestables

## Date

2026-06-28

## Persona(s) adopted

**Systems Engineer** — change lives in the ECS-pipeline + behavior-tree AI layers.

## Routing verdict

✅ right persona — pure logic wiring across `src/game/ai`, no rendering/content.

## Apples

Estimated: 🍎🍎🍎
Actual: 🍎🍎🍎
Verdict: 🎯 Exact — three layers (pipeline, loot targeting, watchdogs) as scoped.

## Systems touched

ai-combat-balance, quests

## What Was Done

- `src/game/ai/simulation-step.ts`: tick `harvestSystem` after `itemPickupSystem`,
  before `dropSystem` — mirrors `MainGameScene` so harvests complete headlessly.
- `src/game/ai/bt-ai-provider.ts`: new `'harvest'` `LootKind`; harvestables feed
  `findNearestLoot` + sticky-target resolver; `isActivelyHarvesting()` re-anchors
  COLLECT + global dwell watchdogs and zeroes the stuck counter so the AI stands
  on a node the 2.5–4s it needs instead of abandoning it.
- Tests: BT harvest-target, dwell-exemption, engage-over-harvest; pipeline
  harvest-completion in `simulation-step.test.ts`.
- ADR-0032; apples json.

## Verification

- `npm run verify`: green — 2539 unit, integration, **headless Floor 1 gate (68)**,
  build. Win-rate gate held (90%+ seeds still win, no regression).

## Notes / Follow-ups

- Harvest only via COLLECT (after Engage); not on-path detours (detours don't
  linger). If a future seed sweep regresses, lower harvest priority/radius — do
  not cherry-pick seeds.
