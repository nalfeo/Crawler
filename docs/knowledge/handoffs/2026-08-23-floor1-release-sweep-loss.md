# Handoff: Floor 1 release sweep loss regression

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-headless-runner

## Apples

4🍎 estimated; implementation stopped under time constraint before full review-harness completion.

## Summary

Fixed the Floor 1 release sweep regression from run `32614037237` (`project:sweep-results-viewer runId=32614037237`) with two minimal headless-runner/AI changes:

- Retained Floor 1's default-on settlement-return routing so parity-gated equipment has a legitimate safe-room return path. The safe-room routing fixes below resolve the release losses without disabling that path.
- Prevented NPC objective routing from switching to the nearby-threat-clear ENGAGE branch while the player is inside a safe room. Weapons are disabled there and watchdogs reset there, which caused pistol seed 38 to livelock after the boss arena instead of returning the merchant prize.
- Made the higher-priority Retreat branch yield inside safe rooms as well. A low-health projectile user cannot resolve threats there; it must interact with the NPC or take the existing egress route. This fixed the Headless Floor 1 Gate's seed 7 RETREAT livelock.
- Deferred optional repeat-spell returns until both Floor 1 boss battles complete. This fixed the gate's seed 5 death by preserving required boss progression ahead of a funded repeat spell purchase.

## Files touched

- `src/game/ai/headless-runner.ts`
- `src/game/ai/bt-ai-provider.ts`
- `tests/headless/floor1-release-sweep-loss-regressions.test.ts`
- `tests/headless/settlement-return-routing.test.ts`

## Verification run

- `npx vitest run --project headless tests/headless/floor1-release-sweep-loss-regressions.test.ts --reporter=verbose` — passed, 4/4 failed release records now official victories.
- `npx vitest run --project headless tests/headless/settlement-return-routing.test.ts --reporter=verbose` — passed, 8/8.
- `npm run verify:fast` — passed, 144 files / 2368 tests plus integrity checks.
- CI-recovery follow-up: seed 7 now reaches victory at frame 32,407 after previously timing out at frame 39,600; release-loss regressions remained 4/4 green; `npm run verify:fast` passed.
- CI-recovery follow-up: seed 5 now reaches victory at frame 16,165 (269.4s); the 4-case release-loss panel and full 25-seed Headless Floor 1 gate both passed.

A full local 300-run Floor 1 release leg was started but stopped under the human time constraint before completion.

## Unresolved issues

- The 4🍎 review ledger/review-harness was initialized but not completed before the human requested no new work; the incomplete scaffold was removed rather than committed.
- `npm run verify:pr-prereqs` had previously failed before this handoff existed and before ledger completion.

## Recommended next steps

- If time permits in a follow-up, complete the required 4🍎 review-harness ledger stages or explicitly re-score with maintainer approval.
- Let CI run the full release/check matrix; focused local regressions and `verify:fast` are green.
