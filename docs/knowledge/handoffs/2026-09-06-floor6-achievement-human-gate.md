# Floor 6 achievement contract repass

## Verdict

Recommended. The approved floor-factory contract is now represented by the
canonical Floor 6 epic.

## Systems touched

agent-epic-lint, floor-factory

## Change

Updated `floor-6-hero-tower-defense.epic.json` to satisfy the achievement
contract introduced by the floor-epic lint. The epic now declares its hard
gate, non-goals, human gates, nine-slice exception, one Owner persona per
slice, progressive playability stages, and a dual-runner spawn-to-victory
acceptance path. The achievement-integrated release slice explicitly covers
unlocking and claiming rewards, with numeric achievement thresholds deferred
to Playtester or Game Designer approval.

## Evidence

- `npm run epics:lint-floor -- docs/knowledge/epics/floor-6-hero-tower-defense/floor-6-hero-tower-defense.epic.json`
- `npm run test:unit -- tests/unit/agent/floor-epic-lint.test.ts`
- `npm run verify:fast`
