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
- Post-review fixes routed the Floor 6 presentation snapshot into the generic scenario presentation contract so `MainGameScene` renders live HUD text and one-shot audio/VFX cues without importing game code; they also fixed south-route direction copy and reset same-world Floor 6 quest progress on restart.

## Files touched

- `src/shared/data/quests.floor6.defense.json`
- `src/shared/quest-types.ts`
- `src/shared/floor-types.ts`
- `src/game/floor6Scenario.ts`
- `src/game/scenarioDefinitions.ts`
- `src/shared/scenario-presentation.ts`
- `src/engine/scenes/MainGameScene.ts`
- `tests/unit/quest-types.test.ts`
- `tests/unit/scenario-definitions.test.ts`
- `tests/unit/floor6-wave-director.test.ts`
- `tests/unit/floor6-presentation-wiring.test.ts`
- `tests/headless/floor6-economy-obs.test.ts`
- `docs/knowledge/metrics/apples/2026-09-02-floor6-slice8-content-presentation.json`
- `docs/knowledge/adr/0102-scenario-hud-snapshot-contract.md`
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
- Independent review pass 1 found that Floor 6 presentation was only exposed through run stats and same-world restarts retained completed quest progress.
- Independent review pass 2 found that route direction labels could mislabel the south route as west when using the spawn→Relay dominant axis.
- `npm run typecheck` — passed after review fixes.
- `npx vitest run --project unit tests/unit/quest-types.test.ts tests/unit/scenario-definitions.test.ts tests/unit/floor6-wave-director.test.ts tests/unit/floor6-presentation-wiring.test.ts` — passed after review fixes, 80/80 tests.
- `npx vitest run --project headless tests/headless/floor6-economy-obs.test.ts` — passed after review fixes, 2/2 tests.
- `bash scripts/agent/verify-fast.sh` — passed after review fixes (808 test files / 11,427 tests plus data-contract and integrity checks; shallow-clone silent-revert guard skipped locally as expected).

## Runtime observation

- Before: Floor 6 already had a real headless defense/victory path, but its default quest registry did not install a Floor 6 objective pack, the Director intro still included stale foundation/offline framing, and `Floor6DefenseRunStats` did not expose presentation-proof labels for routes, build sites, towers, Relay danger, loot, upgrades, breaks, and Deadline escalation.
- After: the real Floor 6 headless pipeline (`runHeadless(new BehaviorTreeAI({ seed: 606 }), { floorId: 'floor6', seed: 606, maxFrames: 7000, questStallFrames: 3000 })`) reaches victory with all Slice 8 quest goals true and exposes deterministic presentation labels for both routes, all build sites, tower range/tier, requisition loot, upgrade choice, service-break safety, Deadline defeated state, and Relay danger without relying on color-only meaning. The real scene presenter now consumes that scenario-owned HUD snapshot through `ScenarioPresentationContract.getHudSnapshot`, renders the lines in `MainGameScene`, and dispatches the authored audio/VFX cues once per cue id.

## Unresolved issues

- This slice projects deterministic presentation state and authored copy. It does not add new generated sprite artifacts; the pre-existing Floor 6 enemy/tower/map data remains the runtime art/content source from the earlier Floor 6 slices.
- **Issue linkage correction**: this PR's description previously declared `Fixes #3980`, but #3980 is the full Slice 8 epic and additionally requires original enemy/tower/production-set assets and set-piece dressing (via the asset-forge and set-piece-designer pipelines), neither of which this PR delivers. Closing #3980 from this PR would leave it marked done while those deliverables are outstanding. The PR description has been corrected to `Related to #3980` (not a closing keyword); #3980 remains open and should be closed only by the PR that lands the outstanding art/set-piece work and its deterministic real-game visual captures.

## Recommended next steps

- Run `npm run verify:pr-prereqs` after this handoff and apple metric are present.
- Run the apple-scaled post-diff review, automated code review, CodeQL checker, and final secret scan before closeout.
- Let any follow-up visual UI implementation consume the `Floor6DefenseRunStats.presentation` snapshot instead of re-deriving floor-specific state in rendering code.
