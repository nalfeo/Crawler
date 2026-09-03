# Floor 1 and 2 release balance telemetry

## Systems touched

ai-combat-balance, release-baseline, ai-headless

## Apples

4 apples estimated, 4 apples actual (exact). The change spans release-baseline
retrieval, deterministic headless telemetry, floor-scoped progression tuning,
and regression coverage.

## Summary

- Increased `find-baseline`'s bounded Git read buffer so it can load a complete
  600-run release artifact rather than failing at Node's default 1 MiB limit.
- Added a pure release-balance analyzer that fixes cohort identity to revision
  2 and reports completion/entry levels, p90 player combat-skill levels, and
  completed versus incomplete boss encounters.
- Added a canonical release-gate helper that enforces the 300/150/150 cohort
  and fails when any required observation is missing or out of range.
- Added `maxCombatSkillLevel` to real `runHeadless` `RunStats`.
- Reduced Floor 1's additive XP to zero and Floor 2's additive XP to two. The
  Floor 2 value is the smallest tested value that retains the existing direct
  first-boss level-10 floor gate.

## Observation

The latest published baseline (`26df582d99a660af0fa1e42a4761e6781b6f557f`,
release matrix revision 2) measured Floor 1 mean completion level 8.02 and
chained final level 20.43. Its historical Floor 1 rows predate boss lifecycle
telemetry and its flattened chain rows do not retain Floor 3 boot level, so
they cannot produce a valid boss-duration or Floor 3-entry measurement. The
new analyzer reports incomplete observations explicitly; the next canonical
release artifact supplies the durable measurement.

Before the Floor 2 correction, a one-XP floor bonus caused direct seeds 1 and 3
to start their first boss at level 9. After setting the floor bonus to two XP,
the real `runHeadless` Floor 2 first-boss gate passes for contiguous seeds 1–3.

## Verification

- `npx vitest run --project unit tests/unit/release-balance.test.ts tests/unit/canonical-release-baseline-acceptance.test.ts`
- `npx vitest run --project headless tests/headless/release-balance-acceptance.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Unresolved

The canonical 600-run release cohort was intentionally not run locally. Its
next CI publication must evaluate the release acceptance bounds with the new
telemetry before further boss-HP tuning can be justified.
