# Handoff: bone-saw PR merge recovery

## Date

2026-07-18

## Persona

Producer

## Systems touched

sprite-pipeline, ci-policy

## Apples

- Estimate: 2🍎
- Actual: 2🍎

## Summary

- Merged `origin/main` into `copilot/nalfeocrawler-1314-create-bone-saw-icon` to clear PR #1366's `mergeable_state: dirty` blocker.
- Resolved the single content conflict in `public/assets/generated/manifest.json` by keeping both shipped equipment entries: this branch's `equipment/weapon/bone-saw` and mainline's `equipment/weapon/iron-cleaver`.
- Re-validated the shipped bone-saw runtime-key path after the merge so the PR still proves the stable generated-asset key resolves through the real manifest loader/preloader path.

## Before / after observation

- Before: GitHub reported PR #1366 as `mergeable_state: dirty`, and local `git merge origin/main` stopped on a manifest conflict where both branches inserted adjacent `equipment/weapon/*` entries.
- After: the branch contains a true merge commit, the manifest keeps both weapon entries, and the real-manifest integration test still loads and preloads `equipment/weapon/bone-saw`.

## Validation

- `npm test -- --run tests/integration/generated-manifest-engine.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Notes

- Existing PR CI on head `44a9ea6` was green before recovery; this session addressed branch drift rather than a failing test/check regression.
