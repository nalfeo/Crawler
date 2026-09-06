# Floor 2 Boss Survival

## Summary

Fixed the production Floor 2 boss spawn path so family bosses use their full authored HP instead of the 3% arena debug scale that was killing them before a single telegraphed signature cycle could play. The retune keeps the fight readable, avoids invulnerability or seed exceptions, and locks the regression behind a deterministic boss-spawn unit test.

## Systems touched

enemies, boss-rooms, ai-combat-balance

## Persona routing

- Producer scoped the fix to the live Floor 2 boss spawn pipeline and trapped it with a regression test.
- AI balance coverage focused on the canonical progression baseline and the boss-level gate.
- QA checked the spawn path and the deterministic boss HP contract rather than a single cherry-picked run.

## Key decisions

- Live Floor 2 boss spawns now respect the archetype's authored HP.
- The 3% HP reduction remains isolated to arena-lab debug presets and is not used by the shipped floor pipeline.
- Bosses survive long enough for their telegraphs and signature cycle without introducing invulnerability or special cases.

## Verification

- `npx vitest run tests/unit/floor2-boss-spawn.test.ts tests/headless/floor2-boss-level-gate.test.ts --reporter=dot`
- `bash scripts/agent/verify-fast.sh` (the repo still shows unrelated baseline regression failures in `tests/unit/baseline-regression-check.test.ts`; the Floor 2 boss suite remains green)

## Apples

3 estimated, 3 actual. The fix stayed scoped to the Floor 2 boss spawn contract and the matching regression coverage.
