# Handoff — Coverage Improvement Loop

**Date:** 2026-06-20
**Session:** coverage-improvement-loop
**Apples:** 🍎🍎🍎 (estimated 3, actual 3, exact)

## Goal

> Improve code coverage, attempting to get to targets. Loop at least 10 times.

Targets (from `docs/agent-os/policies/ci-policy.md`): `src/core` 90%, `src/game` 90%,
`src/shared` 90% lines; `src/engine` 50%.

## What changed

Test-only changes (no `src/` modified). 10+ iterations adding focused unit tests
for the lowest-coverage source files, validated per-file then with `verify:fast`.

### New test files

| File                                              | Target source       | Before → after (lines) |
| ------------------------------------------------- | ------------------- | ---------------------- |
| `tests/unit/floor-registry.test.ts`               | floor-registry      | 0% → 100%              |
| `tests/ecs/door-lock-validation.test.ts`          | door-lock           | 65% → 92%              |
| `tests/ecs/door-navigation.test.ts`               | door-navigation     | 83% → 100%             |
| `tests/unit/logger.test.ts`                       | logger              | 59% → 98%              |
| `tests/ecs/quest-system-coverage.test.ts`         | questSystem         | 85% → 93%              |
| `tests/ecs/area-damage-system-branches.test.ts`   | areaDamageSystem    | 76% → 96%              |
| `tests/ecs/door-system-safe-room.test.ts`         | doorSystem          | 82% → 100%             |
| `tests/ecs/beam-system-branches.test.ts`          | beamSystem          | 88% → 98%              |
| `tests/ecs/aoe-on-impact-system.test.ts`          | aoeOnImpactSystem   | 64% → 100%             |
| `tests/ecs/drop-system-knockback.test.ts`         | dropSystem          | 88% → 100%             |
| `tests/unit/level-up-allocation-branches.test.ts` | level-up-allocation | 89% → 98%              |
| `tests/game/behavior-tree-framework.test.ts`      | behavior-tree       | 45% → 91.6%            |
| `tests/game/auto-progression-npc.test.ts`         | ai/auto-progression | 36% → 65%              |
| `tests/ecs/knockback-system.test.ts`              | knockbackSystem     | 88% → 100%             |
| `tests/ecs/damage-system-branches.test.ts`        | damageSystem        | branch coverage up     |

### Modified test files

- `tests/unit/session-server-env.test.ts` — "warns at most once" guard.
- `tests/unit/quest-types.test.ts` — `getAllQuestDefs` + schema refine errors (89% → 93.5%).
- `tests/game/skill-registry.test.ts` — superRefine validation branches (87% → 100%).

## Result (unit-project, line coverage)

- **core: 91.9% → 96.5%** ✅ (≥90% target)
- **shared: 91.2% → 96.9%** ✅ (≥90% target)
- game: 65.7% → 67.6% (unit-only — see caveat)
- engine: 15.3% (unit-only — see caveat)

## Caveats / open items

- **game unit-only (67.6%) is below 90%, but the gap is in AI/headless files**
  (`src/game/ai/bt-ai-provider.ts`, `headless-runner.ts`, `headless-runner-cli.ts`)
  that are exercised by the **headless** vitest project, not the unit project.
  `auto-progression.ts`'s `autoFloor1ProgressionSystem` similarly needs full
  Floor 1 scenario state (headless integration). These are not unit-testable in
  isolation without large fixtures.
- **engine** is covered by the e2e/browser projects, not the unit project.
- **Pre-existing blocker:** full `npm run verify` / all-projects `test:coverage`
  FAILS due to sprite-pipeline integration tests that need external VLM/image
  providers (`tests/integration/generate-one.test.ts`,
  `judge-budget-cache.test.ts`, `judge-pipeline.test.ts`). These are unrelated to
  coverage and were failing before this session. `npm run verify:fast` is green.

## Tips for next agent

- Per-file coverage loop: `npx vitest run <testfile> --project unit --coverage
--coverage.reporter=text --coverage.include='src/path/file.ts'`.
- For exact uncovered lines, add `--coverage.reporter=json` then parse
  `coverage/coverage-final.json` (`.s` hit counts === 0 → uncovered, map id via
  `.statementMap`).
- `Stats` component is a tag; armor lives in `world.stores.stats.armor[eid]`
  (written by statsSystem, not via `set(Stats, …)`).
- To raise `game` toward target, run/measure the **headless** project coverage
  for the AI driver files rather than chasing them in the unit project.
