# Floor 6 player economy controls — PR 1 publication

## Systems touched

floor6-scenario, scenario-presentation, main-game-scene, floor6-tests

## Summary

- Completed the occupied-site control path: an ordinary touch site tap can build, select an available authored upgrade, and sell through the real `MainGameScene` picker.
- Restored the build-result toast to name the built tower and its site; upgrade purchases retain their generic accepted confirmation and sales name the reopened site.
- Added ADR 0108 to record the renderer-neutral ownership seam: the scenario projects state and owns transactions, while the renderer only sends requests and presents results.
- No tower/enemy role, wave, finale, or economy tuning data changed.

## Observation

- Real-scene E2E now proves touch build → upgrade → sell on an authored Floor 6 site, including rendered tower creation and removal.
- A separate public, non-debug Floor 6 run booted into DEFEND at zero requisitions. It reached critical Relay danger before earning currency in the fixed default start. That is a pacing/role-design concern deliberately left unchanged by this controls-only PR; do not represent this PR as solving it.

## Verification

- `npm run preflight` completed with pinned Node 22.23.2 (the terminal foreground cap required a background completion for its final phase).
- `npx vitest run --project unit tests/unit/floor6-towers.test.ts` passed (9/9).
- `npx vitest run --project e2e tests/e2e/main-game-scene-floor6-scenario-hud.test.ts` passed (6/6).
- `npm run verify:fast` passed.
- `npm run verify:pr-prereqs` passed after ADR 0108 was added.
- Fresh local Ducky review ran with no blocking or medium findings; an independent reviewer pass checked determinism, layer ownership, real-scene coverage, and scope.

## Publication notes

- The takeover worktree is intentionally detached at the committed branch tip because `codex/floor6-player-economy-controls` remains checked out in its original worktree. `npm run sync:main -- --reason pre-publish` therefore reported its documented detached-HEAD deferral. Publish the detached commit to the same remote branch ref; do not force-push unrelated history.
