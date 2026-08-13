# Handoff: Fun evaluation personas and criteria

## Systems touched: ai-behavior-tree

## Apples

Estimated: 3🍎 (Medium) — actual: 3🍎. Added deterministic evaluator cohorts,
criteria reporting, runtime persona propagation, focused tests, and the
framework contract update.

## Summary

- Added `new_player`, `experienced_player`, `min_max_cheeser`, and `explorer`
  deterministic persona presets for headless evaluation.
- Added `--persona` parsing and retained the selected persona in `RunStats`.
- Added non-gating fun criteria reporting for unsafe combat uptime,
  survivability variance, run variety, dopamine cadence, snowball frequency,
  meta progression, and item viability.
- Added per-persona score breakdowns so aggregate scores cannot hide cohort
  regressions.
- Added optional `--baseline` comparison output with non-gating trend statuses.
- Documented the criteria targets and telemetry limitations in the fun
  evaluation framework.

## Files touched

- `src/game/ai/personas.ts`
- `src/game/ai/types.ts`
- `src/game/ai/headless-runner.ts`
- `src/game/ai/headless-runner-cli.ts`
- `src/game/ai/headless-runner-cli-lib.ts`
- `src/game/ai/index.ts`
- `scripts/agent/health/fun-score-lib.ts`
- `scripts/agent/health/fun-score.ts`
- `tests/unit/ai/headless-runner-cli-lib.test.ts`
- `tests/unit/fun-score-lib.test.ts`
- `docs/knowledge/game-design/playtest-fun-eval-framework.md`

## Verification

- `git diff --check` ✅
- `npm run verify:fast` ⚠️ blocked: dependencies are unavailable in the
  worktree; npm attempted temporary `tsc`/`eslint` installs, but the local
  TypeScript compiler and Vitest were not present.
- Targeted Vitest tests not run for the same dependency reason.

## Unresolved issues

- Dopamine event timestamps, snowball classification, permanent progression,
  item exposure/contribution telemetry, baseline comparisons, and scheduled
  invocation remain follow-up work.
- The survivability criterion currently uses normalized outcome dispersion as a
  proxy and should not be treated as authoritative until phase-aware telemetry
  exists.

## Recommended next steps

- Add event, item, and meta-progression telemetry to the real headless runner.
- Add baseline-vs-candidate trend statuses and append-only timer artifacts.
- Restore dependencies and run targeted tests, typecheck, lint, and
  `npm run verify:fast`.
