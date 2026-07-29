# Handoff: Quest arrow CI recovery

**Date:** 2026-07-25  
**Session slug:** quest-arrow-ci-recovery  
**Apple estimate:** 2🍎  
**PR:** #1941

## Systems touched

hud-ux, ci-policy, sprite-pipeline

## What changed

- Removed the runtime Phaser import from `src/engine/HudDirectionArrows.ts`'s pure layout module and replaced the two `Phaser.Math.Clamp` calls with a local helper so Node-based unit tests can import the file without a browser `window`.
- Updated the UX snapshot lab's tracked-waypoint probe to mutate the existing objective position objects instead of reassigning readonly fields, matching the current Floor 1 objective typing.
- Tightened the new minimap visual regression to use waypoint positions and probe windows that reliably cross the overlay/radar visibility thresholds during zoom/pan.
- Aligned `tests/unit/sprites/caching-run-store.test.ts` RunStore doubles with the current `RunStore` signatures (`ListOptions`, explicit args) to satisfy Lightweight Checks type validation.

## Validation

- GitHub Actions failure logs for run `30149801675` (Unit Tests, E2E Visual — Game/UI, Lightweight Checks)
- `npm run scope`
- `npm run verify:pr-prereqs`
- `git diff --check`
- `parallel_validation`
- Secret scan on changed files

## Notes

- Local `npm run verify:fast` remained blocked in this sandbox because dependencies were not installed and `npm install` could not fetch lockfile tarballs from `ms-feed-2.pkgs.visualstudio.com` (`ENOTFOUND`). CI is expected to perform the first full lint/typecheck/test pass for this recovery patch.
