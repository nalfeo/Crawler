# Floor achievement contract final repass

## Systems touched

floor-epic-planning

## Verdict

Recommended, 2 apples. This was a bounded tooling and planning-contract
repass; the review gaps were deterministic contract failures, not gameplay
changes.

## Changes

- Updated the canonical Floor 4, Floor 5, and Floor 6 epic manifests so each
  has one owned achievement slice with direct prerequisite mechanic metadata.
- Added the missing specialist owners, dual-runner evidence, stage language,
  release ordering, and achievement acceptance evidence to the affected
  canonical plans.
- Preserved the lint's exact-one achievement-slice and direct-prerequisite
  enforcement and verified the direct `tsx` CLI path.

## Evidence

- `npm test -- --run tests/unit/agent/floor-epic-lint.test.ts` — 53 tests passed.
- `npm run epics:lint-floor -- <canonical Floor 4, 5, and 6 epic>` — all OK.
- `npm run verify:fast` — passed.
- `npm run format:check` on changed files — passed.

## Review resolution

The duplicate achievement-slice and unrelated-dependency findings are covered
by the existing deterministic fixtures and enforcement. The final repass also
made the three canonical manifests targeted by the review pass their own
achievement, ownership, and release-contract lint.
