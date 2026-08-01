# Handoff — xp sweep review recovery

## Systems touched

ai-behavior-tree, ai-combat-balance

## Summary

- Fixed the pre-exit XP sweep safety gate so it treats ignored nearby enemies as
  physically dangerous and blocks the sweep when they are inside engage range.
- Corrected the new sweep unit fixture to place XP relative to the player, which
  matches the generated scenario geometry and fixes the CI-red happy-path test.
- Added explicit Floor 2 pre-exit sweep coverage for the unlocked/spawned/
  positioned/undiscovered branch plus negative guards for each Floor 2-only
  condition.
- Added deterministic headless telemetry coverage for `xpOnGroundAtEnd` on both
  the normal completion path and the caught error path.
- Added `runStartXp` to `RunStats` and updated the XP-efficiency documentation so
  callers can subtract seeded start-level baseline XP when evaluating direct
  Floor 2 runs.

## Validation

- Review-thread validation agents (separate model) marked all four requested
  threads valid and drove the final repair scope.
- GitHub Actions failure logs showed the active CI break was the new
  `bt-pre-exit-xp-sweep` happy-path test; merge-gate failures cascaded from that.
- `runtime-tools-secret_scanning` passed on all modified source/test files.
- Local `npm install` / Vitest execution was blocked by environment-level npm
  tarball rewriting to `ms-feed-12.pkgs.visualstudio.com` (`ENOTFOUND`), so full
  repo verification could not be rerun in-session.
- Global `tsc --noEmit` was used as a fallback static check; after fixing one
  implicit-`any` in the new Floor 2 table test, remaining errors touching edited
  files were dependency-resolution failures (`vitest`, `bitecs`) caused by the
  blocked install rather than code-level type errors in the repair.

## Unresolved issues

- Full local `verify:fast` / Vitest reruns remain blocked until npm package
  installation can reach the environment’s rewritten tarball host or the rewrite
  is disabled upstream.
