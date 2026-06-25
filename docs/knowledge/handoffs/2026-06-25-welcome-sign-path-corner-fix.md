# Handoff — 2026-06-25 welcome-sign-path-corner-fix

## Summary

Fixed two navigation issues:

- Floor 1 welcome signs now follow the actual door-aware navigable room path instead of pointing straight at the welcome office across the map.
- AI line-of-sight smoothing now rejects blocked diagonal corner cuts, preventing path-follow from getting stuck trying to squeeze through an `OX / XO` corner.

## Persona Routing

- **Producer** — coordinated the cross-cutting fix and validation.
- **Game Designer / Systems Engineer slice** — updated Floor 1 sign routing and AI path smoothing behavior.
- **QA Engineer slice** — added focused regressions for seed `731683` and blocked-corner LOS behavior.

## What Changed

### Welcome signs

In `/home/runner/work/Crawler/Crawler/src/game/floor1Scenario.ts`:

- Added `findNavigableRoomPath(...)`, which derives the welcome breadcrumb route from the real tile path while treating door tiles as navigable.
- Exported that helper so tests can validate against the same room-path derivation as production.
- Replaced the coarse room-neighbor path lookup for welcome signs with the door-aware navigable room path.
- Removed the fallback that pointed the spawn-room sign directly at the welcome office when the coarse graph collapsed distant rooms into a single hop.
- Added a named spacing helper so welcome signs are dropped every 2–3 rooms while still pointing to the immediate next room on the real path.

### Corner path smoothing

In `/home/runner/work/Crawler/Crawler/src/game/ai/bt-ai-provider.ts`:

- Hardened `hasClearLineOfSight(...)` so it tracks tile transitions between LOS samples.
- When a sampled segment crosses tiles diagonally, it now rejects the shortcut if both orthogonal side steps are blocked, matching runtime movement collision.

In `/home/runner/work/Crawler/Crawler/src/labs/ai-runner-lab/path-overlay.ts` and `/home/runner/work/Crawler/Crawler/src/labs/ai-runner-lab/index.ts`:

- Mirrored the same blocked-corner LOS rule in the AI runner overlay so the debug path matches the AI's real movement decisions.
- Passed the floor map's `pixelToTile` mapping explicitly to keep the overlay aligned with runtime tile transitions.

## Tests Added / Updated

- `/home/runner/work/Crawler/Crawler/tests/game/welcome-signs.test.ts`
  - Added a seed `731683` regression that verifies signs sit on the navigable room path, appear every 2–3 rooms, and point along the next room-to-room step instead of directly at the goal.
  - Reused the exported navigable-room helper so test expectations match production path extraction.
- `/home/runner/work/Crawler/Crawler/tests/game/behavior-tree-ai.test.ts`
  - Added a regression proving the AI provider treats a blocked diagonal corner as obstructed.
- `/home/runner/work/Crawler/Crawler/tests/unit/labs/ai-runner-path-overlay.test.ts`
  - Added a matching overlay LOS regression for blocked diagonal corners.

## Files Changed

- `src/game/floor1Scenario.ts`
- `src/game/ai/bt-ai-provider.ts`
- `src/labs/ai-runner-lab/path-overlay.ts`
- `src/labs/ai-runner-lab/index.ts`
- `tests/game/welcome-signs.test.ts`
- `tests/game/behavior-tree-ai.test.ts`
- `tests/unit/labs/ai-runner-path-overlay.test.ts`

## Verification

- `npx vitest run tests/game/welcome-signs.test.ts tests/game/behavior-tree-ai.test.ts tests/unit/labs/ai-runner-path-overlay.test.ts --reporter=dot` ✅
- `npm run verify:fast` ✅
- `npm run verify` ✅
- `parallel_validation` ✅ Code review + CodeQL run completed once with no security alerts; follow-up rerun was skipped because the session hit the validation tool time limit after only minor cleanup changes.

## Apples

- Estimated: 🍎🍎🍎 (Medium)
- Actual: 🍎🍎🍎 (Medium)
- Delta: 0
- Verdict: exact
- Hello kitties: 0.60

## Branch

- `copilot/seed-731683-welcome-signs-adjustment`

## Blockers

- None.
