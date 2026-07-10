# Session Handoff: AI runner floor/seed/scenario apply + playback UX refresh

## Date

2026-07-08

## Persona

Producer

## Systems touched

devtools, hud-ux, ai-behavior-tree, inventory

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Summary

Fixed the AI runner lab run-settings flow so floor/seed/scenario changes apply through one restart action and visibly affect the runtime world. The floor/scenario controls were merged into a single run-target selector with one apply button, and the playback controls were moved into a sticky themed dock so run/pause/speed/manual controls stay visible.

Also fixed a scene-restart crash path in `EquipmentUI` teardown that could break run-setting restarts (`drawImage` null errors during tooltip cleanup on destroy).

## Files touched

- `src/labs/ai-runner-lab/index.ts`
- `src/engine/EquipmentUI.ts`
- `tests/unit/ai-runner-run-settings-wiring.test.ts`
- `docs/knowledge/review-ledgers/2026-07-08-ai-runner-floor-seed-fix.review-ledger.json`

## Verification run

- `npm run verify:fast`
- Visual runtime validation in lab (`http://127.0.0.1:5641/lab.html?lab=ai-runner`):
  - Scenario apply (`scenario:spawner-cave`) + seed update changes map/start state.
  - Floor apply (`floor:floor2`) now shows runtime `effectiveFloor: floor2` with Floor 2 quests active.

## Unresolved issues

None identified for this scope.

## Recommended next steps

1. If desired, add a small deterministic e2e/assertion around run-target apply so floor/scenario regression is caught automatically.
