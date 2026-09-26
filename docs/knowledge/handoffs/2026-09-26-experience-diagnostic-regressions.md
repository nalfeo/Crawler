# Session Handoff: Controlled experience diagnostic regressions

## Date

2026-09-26

## Persona

QA Engineer

## Systems touched

ai-combat-balance

## Apples

2 apples estimated and actual; routine test-only change.

## What Was Done

Extracted the existing evaluator run fixture unchanged into tests/fixtures/experience-evaluation.ts. Added controlled synthetic pairs for sparse reward timing, stuck movement, reduced acquired XP/levels, selected-but-inert items, missing evidence, repeated reward records, and mismatched starter/count/duplicate/scenario/seed cohorts. Matched pairs retain outcome and duration and verify independent cohort compatibility. Explicitly assert degradation direction for reward cadence and item viability.

Observed in synthetic evaluator artifacts: the longest reward gap rises from 80 to 290 seconds with unchanged reward count, while inert selected-item fraction rises from 0 to 1. These are fabricated test inputs, not runtime measurements or player evidence. No gameplay code changed and no gameplay evaluation runs were performed. Required fast verification ran two 800-frame size/weight coverage probes. Focused evaluator suites pass all 38 tests; fast verification and PR prerequisites passed. Ducky complete-diff review found no actionable regressions. Repository-wide handoff lint reports three pre-existing missing retrospective subsections in 2026-09-26-merge-train-synchronize-reevaluation.md; this handoff has all required subsections.

## Key Decisions Made

Use existing RunStats fields and Vitest assertions rather than inventing a telemetry adapter. Unsafe combat uptime, choice depth, run distinctness, and enjoyment confidence remain unmeasured. Required coverage fails when its evidence disappears. Duplicated runs and mismatched cohorts cannot establish improvement. Tests are diagnostic sensitivity checks, not enjoyment calibration.

## What's Next / Blockers

Publish ready for review after required fast checks, PR prerequisites and complete-diff Ducky review; record final validation in the PR. Release ownership immediately to CI Recovery and the normal merge train. Future instrumentation needs its own producer/consumer contract and real runtime evidence; this fixture does not implement it. No guard-telemetry file was present at handoff creation.

## Retrospective

### Lessons Learned

Session identity fields are readonly even though RunStats fields are mutable; construct session variants with object spreads.

### Mistakes Made

The inherited tests assigned readonly id and scenario fields. Full typechecking exposed this despite passing Vitest execution; both assignments were replaced before publication.

### Opportunities for Future Improvement

Extend controlled tests when supported unsafe-combat and meaningful-choice telemetry becomes available, without representing absent fields as measured zero.
