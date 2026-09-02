# Handoff: Floor 6 Slice 8 — content and presentation proof

## Systems touched

quests, hud-ux, enemies, inventory, ci-policy

## Apples

5 apples estimated, 5 apples actual (exact). The issue spanned declarative quest data, Floor 6 scenario authority, Director presentation, shared run-stat contracts, headless evidence, and PR policy/review prerequisites.

## Summary

Implemented the Floor 6 Slice 8 declarative objective and presentation layer on top of the existing Floor 6 defense scenario authority:

- Added the `floor6-defense` quest pack to the validated default quest registry, with goal objectives for briefing, first wave clear, first tower build, first upgrade choice, break safety, Deadline defeat, and Relay-secured exit.
- Projected those quest goals from the authoritative `Floor6DefenseState` into generic `world.goalFlags`; no Floor 6 quest-only booleans or runtime LLM generation were added.
- Extended Floor 6 run stats with a deterministic presentation snapshot covering objective text, phase, route direction labels, buildable versus occupied plinths, tower range/tier labels, requisition/loot state, upgrade choice state, service-break safety, Deadline state, Relay danger, and audio/VFX/HUD cue labels.
- Updated Floor 6 Director intro and milestone copy to describe the live Broadcast Relay defense instead of stale foundation/offline status.
- Wired Floor 6 stair marker and confirmation copy through the scenario presentation contract so the Relay exit is shown only from the authoritative victory/exit state.
- Added focused unit and headless coverage proving registry install, scenario presentation, quest projection, and real headless Floor 6 Slice 8 evidence.

## Files touched

- `src/shared/data/quests.floor6.defense.json`
- `src/shared/quest-types.ts`
- `src/shared/floor-types.ts`
- `src/game/floor6Scenario.ts`
- `src/game/scenarioDefinitions.ts`
- `tests/unit/quest-types.test.ts`
- `tests/unit/scenario-definitions.test.ts`
- `tests/unit/floor6-wave-director.test.ts`
- `tests/headless/floor6-economy-obs.test.ts`
- `docs/knowledge/metrics/apples/2026-09-02-floor6-slice8-content-presentation.json`
- `docs/knowledge/handoffs/2026-09-02-floor6-slice8-content-presentation.md`

## Verification run

- `bash scripts/agent/preflight.sh` — passed before code changes.
- `npm run typecheck` — failed once on a readonly local cue-array annotation and a scoped Floor 6 stair-marker helper; both were fixed.
- `npm run typecheck` — passed after fixes.
- `npx vitest run --project unit tests/unit/quest-types.test.ts tests/unit/scenario-definitions.test.ts tests/unit/floor6-wave-director.test.ts` — failed once because one Floor 6 intro variant used `Relay` instead of the required `Broadcast Relay`; copy was corrected.
- `npx vitest run --project unit tests/unit/quest-types.test.ts tests/unit/scenario-definitions.test.ts tests/unit/floor6-wave-director.test.ts` — passed, 77/77 tests.
- `npx vitest run --project headless tests/headless/floor6-economy-obs.test.ts` — passed, 2/2 tests.
- `npx prettier --write src/game/floor6Scenario.ts src/game/scenarioDefinitions.ts src/shared/floor-types.ts src/shared/quest-types.ts src/shared/data/quests.floor6.defense.json tests/headless/floor6-economy-obs.test.ts tests/unit/floor6-wave-director.test.ts tests/unit/quest-types.test.ts tests/unit/scenario-definitions.test.ts` — completed; only `src/game/floor6Scenario.ts` changed.
- `npm run typecheck` — passed after formatting.
- `npx vitest run --project unit tests/unit/quest-types.test.ts tests/unit/scenario-definitions.test.ts tests/unit/floor6-wave-director.test.ts` — passed after formatting, 77/77 tests.
- `npx vitest run --project headless tests/headless/floor6-economy-obs.test.ts` — passed after formatting, 2/2 tests.
- `bash scripts/agent/verify-fast.sh` — passed (807 test files / 11,424 tests plus data-contract and integrity checks; shallow-clone silent-revert guard skipped locally as expected).

## Runtime observation

- Before: Floor 6 already had a real headless defense/victory path, but its default quest registry did not install a Floor 6 objective pack, the Director intro still included stale foundation/offline framing, and `Floor6DefenseRunStats` did not expose presentation-proof labels for routes, build sites, towers, Relay danger, loot, upgrades, breaks, and Deadline escalation.
- After: the real Floor 6 headless pipeline (`runHeadless(new BehaviorTreeAI({ seed: 606 }), { floorId: 'floor6', seed: 606, maxFrames: 7000, questStallFrames: 3000 })`) reaches victory with all Slice 8 quest goals true and exposes deterministic presentation labels for both routes, all build sites, tower range/tier, requisition loot, upgrade choice, service-break safety, Deadline defeated state, and Relay danger without relying on color-only meaning.

## Unresolved issues

- This slice projects deterministic presentation state and authored copy. It does not add new generated sprite artifacts; the pre-existing Floor 6 enemy/tower/map data remains the runtime art/content source from the earlier Floor 6 slices.

## Recommended next steps

- Run `npm run verify:pr-prereqs` after this handoff and apple metric are present.
- Run the apple-scaled post-diff review, automated code review, CodeQL checker, and final secret scan before closeout.
- Let any follow-up visual UI implementation consume the `Floor6DefenseRunStats.presentation` snapshot instead of re-deriving floor-specific state in rendering code.
