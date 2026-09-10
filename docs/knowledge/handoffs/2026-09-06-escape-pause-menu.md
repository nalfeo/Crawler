# Escape pause menu and close hierarchy

**Date:** 2026-09-06
**Apples:** 3🍎 estimated → 3🍎 actual
**Persona:** producer

## Systems touched

hud-ux, mobile-ux

## What changed

- Centralized `Escape` handling in `MainGameScene` so the topmost closable panel closes first and never triggers a second pause action.
- Added a pause-menu modal that reuses the shared `ModalPickerUI` pattern, with `Resume`, `↺ Restart`, and `← Quit` options.
- Preserved the scene's prior pause state when the pause menu closes so `Escape` resumes or dismisses consistently without leaving the run in the wrong state.
- Kept inventory and the other modal surfaces on the same hierarchy contract, matching the issue's acceptance criteria.
- Added deterministic E2E coverage that asserts the hierarchy and the fact that gameplay time stops while paused.

## Evidence

Validated with the targeted scene/UI suite:

```
npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts --reporter=default
```

Result: 1 file passed, 28/28 tests passed.
