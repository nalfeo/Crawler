# Handoff: PR #3377 merge recovery

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree

## Apples

2🍎 (merge-conflict recovery + review-thread validation)

## Summary

Recovered PR #3377 from a conflict with `origin/main` by creating merge commit `97d31825` on top of local head `1237e02` and `origin/main` `80e7ea9`.

The only content conflict was in `src/game/ai/bt-ai-provider.ts`. Main had already hoisted the post-boss Spell Broker return guard above settlement-return routing, so the resolution kept the hoisted guard and removed the duplicate lower branch-side block before `resolveFloor1MiddleChainObjective`.

Automated review then caught that the hoisted guard had lost the branch's explicit `spellQuestGiverNpcEid == null` early return. Follow-up commit `2389bd07` restored that guard and passes a real NPC eid into the progress target.

## Review thread

Revalidated review thread `PRRT_kwDOSvo2Ms6beJvE:e5245ef73f895ac7f7a75856d3597da38e6681e67db3d2e65c9c88eee3b15ccc` with a separate validator. The stale addressed marker pointed at an unreachable commit, but current head `2389bd07` contains the release-loss coverage and fix. Posted the current-head marker on original review comment `3838084074`.

Baseline sweep context remains `project:sweep-results-viewer runId=32625255085`.

## Verification run

- `npx vitest run --project headless tests/headless/floor1-throwing-knife11-release-regression.test.ts tests/headless/floor1-release-sweep-loss-regressions.test.ts --reporter=verbose` — passed (6/6) before and after the NPC guard fix.
- `bash scripts/agent/verify-fast.sh` — passed before and after the NPC guard fix.
- Secret scanning on changed files — no secrets detected.
- Automated code review — clean after `2389bd07`.
- CodeQL checker — 0 JavaScript alerts reported; database-size limit caused analysis skip.

## Notes

- Do not run `npm run docs:index`; CI rebuilds the generated handoff index.
