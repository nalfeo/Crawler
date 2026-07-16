# Handoff: PR #1054 merge conflict resolution

**Date:** 2026-07-13  
**PR:** #1054  
**PR branch:** `copilot/fix-weapon-skill-xp-misattribution`  
**Apple estimate:** 2🍎  
**Actual apples:** 2🍎  
**Verdict:** Completed

## Systems touched

weapons

## Summary

Merged current `origin/main` into PR #1054 and resolved the weapon-attribution conflicts by keeping the newer mainline implementation.

- Accepted the `origin/main` weapon-attribution plumbing in `src/core/world.ts`,
  `src/core/weapon-skill-bridge.ts`, `src/game/weaponSystem.ts`, and the
  affected damage/beam/melee/trap/AoE systems. This keeps the merged branch on
  the repository's current API shape (`attackerWeaponSkills` +
  `attackWeaponSkillsByEntity`) instead of the older `attackSkillSources`
  variant from the PR branch.
- Aligned the remaining local attribution tests and `lifetimeSystem` with that
  newer API so the merge result typechecks and the hit-gated skill-XP
  regressions still pass.
- Kept the rest of `origin/main` intact; no extra behavior changes were added on
  top of the conflict resolution.

## Validation

```bash
cd /home/runner/work/Crawler/Crawler
npx vitest run tests/game/weapon-skills.test.ts tests/ecs/aoe-on-impact-system.test.ts tests/ecs/trap-system.test.ts tests/ecs/damage-system-branches.test.ts tests/ecs/beam-system-branches.test.ts tests/ecs/area-damage-system-branches.test.ts
npm run verify:fast
```

## Review ledger

- `docs/knowledge/review-ledgers/2026-07-13-pr1054-merge-conflicts.review-ledger.json`
