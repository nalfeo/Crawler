# Persistent dev issue button

## Systems touched

hud-ux

## Summary

- Kept the dev-build Issue affordance visible above active gameplay UX.
- Gave issue reporting a dedicated topmost picker so underlying UX remains intact.
- Routed keyboard input exclusively to the issue picker while it is open.
- Kept terminal/restarting states excluded because their timers and run outcomes require terminal-specific reporting semantics.

## Validation

- Before, the real `main-scene-probe-lab` reported `inventoryOpen=true` and
  `issueButtonVisible=false`.
- After, focused e2e coverage clicks Issue over Inventory, preserves Inventory and
  pause state, and proves loadout/Skills do not receive issue-picker keyboard input.
- `npm run verify:fast` passed (144 files, 2368 tests) before the terminal guard refinement.
- Final refinement: `npm run typecheck` and 8 focused unit assertions passed.

## Apples

3🍎 estimated, 3🍎 actual (exact).
