# Small-screen Issue button placement

## Systems touched

hud-ux

## Summary

- Kept the dev Issue affordance in its existing desktop stack position at the design scale.
- Moved Issue to the top of a second corner-button column when responsive touch controls scale above 1×.
- Added real-scene e2e coverage for the Issue button and transformed skill-panel bounds at 960×540.

## Validation

- Before, the focused `main-scene-probe-lab` e2e observed intersecting Issue and skill-panel bounds at 960×540.
- After, the same deterministic bounds assertion passed with no intersection.
- `npm run typecheck`, focused ESLint, Prettier, the overlap regression, and the separately rerun abilities-loadout case passed.

## Apples

2🍎 estimated, 2🍎 actual (exact).
