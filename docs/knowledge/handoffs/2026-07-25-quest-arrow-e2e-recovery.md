# Handoff: Quest arrow E2E recovery

## Date

2026-07-25

## Persona

UX Designer

## Systems touched

hud-ux

## Apples

2🍎 estimated, 2🍎 actual.

## What Was Done

- Investigated PR #1941's live CI blockers through GitHub Actions and confirmed the only real failing job on run `30151538307` was `E2E Visual — Game/UI`; the top-level `ci` and `Merge gate` failures were aggregate fallout.
- Confirmed the PR had no remaining open review threads; the previously raised minimap-arrow threads were already resolved.
- Reworked the minimap arrow E2E probe seam instead of changing gameplay/render behavior:
  - `src/engine/HudMinimap.ts` now records the runtime-computed bounds of the overlay waypoint edge arrow and docked radar waypoint edge arrow whenever those triangles are actually drawn.
  - `src/engine/HudUI.ts` and `src/labs/ux-snapshot-lab/index.ts` expose those bounds to the existing UX snapshot probe.
  - `tests/e2e/minimap-overlay.test.ts` now waits for those runtime bounds and samples pixels inside the actual arrow triangle region instead of hard-coded guessed probe boxes that could miss the overlay arrow or hit the radar's gold frame.

## Validation

- GitHub Actions diagnosis:
  - workflow run `30151538307`
  - failed job: `E2E Visual — Game/UI`
  - failing assertions:
    - `tests/e2e/minimap-overlay.test.ts > ... overlay edge arrow ...` (`expected false to be true`)
    - `tests/e2e/minimap-overlay.test.ts > ... radar edge arrow ...` (`expected true to be false`)
- `git diff --check`
- `npm run scope` → `art_only=false`, `docs_only=false`, `gameplay_safe=false`
- `npm run verify:pr-prereqs`

## Environment Notes

- Local package validation remains sandbox-limited: `vitest` is absent from the partial `node_modules` install, and `npm ci` cannot repair it because lockfile tarballs from `ms-feed-2.pkgs.visualstudio.com` fail DNS resolution (`ENOTFOUND`).
- Because of that dependency blocker, the repaired minimap E2E spec could not be re-run locally in this session; authoritative verification is expected from the next GitHub Actions run on the pushed branch head.
