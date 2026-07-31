# Handoff: Floor 2 equipment rarity decoupling

## Date

2026-07-31

## Systems touched

inventory, quests, weapons

## Apples

Estimated: 3🍎  
Actual: 3🍎

## Summary

- Removed the reward-bundle resolver's Common-only `illegal-base` rejection path, so Common eligibility is no longer blocked by authored non-armor base riders.
- Updated generated equipment realization so non-armor base stat bonuses are not copied into generated instance frozen stats; non-armor power is now rarity-affix-driven.
- Kept inherent armor scaling behavior unchanged.
- Updated coupled tests and nearby docs/comments (including ADR 0069/0070 amendment notes) to reflect the new contract.

## Validation

- `npx vitest run tests/unit/floor2-reward-bundle-resolver.test.ts tests/game/generated-equipment-generator.test.ts` ❌
  - Failed in this sandbox because project vitest/typescript/eslint dependencies are not available locally and `npm ci` cannot complete due blocked network access (`ENOTFOUND ms-feed-12.pkgs.visualstudio.com`).
- `npm run verify:fast` ❌
  - Same dependency/bootstrap blocker as above.
- `runtime-tools-secret_scanning` ✅ clean on all changed files.
- `parallel_validation` ✅ no findings reported by available validators in this environment.

## Notes

- Attempted to post the requested pre-code implementation plan comment to issue #2403 via `gh issue comment`, but GitHub API permission returned `403 Forbidden` in this runtime.
