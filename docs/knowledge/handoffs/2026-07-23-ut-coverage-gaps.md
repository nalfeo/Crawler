# Handoff: Address top 5 most critical UT coverage gaps

**Date:** 2026-07-23  
**PR:** (see open PR)  
**Apple estimate:** 🍎🍎🍎 (3 apples)  
**Systems touched:** knockback, ability-system, skill-system, family-feud, progression-effects

## Summary

Added 5 new test files targeting the known unit-test coverage gaps identified in
`docs/knowledge/handoffs/2026-07-04-coverage-pass.md`. No production code was changed.

## Test files added

| File | Coverage gap addressed | Tests |
|------|------------------------|-------|
| `tests/ecs/knockback-system-flying.test.ts` | `knockbackSystem` Flying entity bounds clamping (~84.5% → higher) | 6 |
| `tests/game/ability-system-error-codes.test.ts` | `abilitySystem` `unknown-ability` + `kind-mismatch` + `memorizeSpell` errors (~90.4% → higher) | 6 |
| `tests/game/skill-system-branches.test.ts` | `skillSystem` v1 fallback, no-player edge, level-10/15 milestones | 6 |
| `tests/game/family-feud-coverage.test.ts` | `familyFeudSystem` boss skip, `getMobFamilyId` fallback, speed-only decision (~89.5% → higher) | 5 |
| `tests/game/progression-effects-coverage.test.ts` | `progressionEffects.applyCatalogEffect` `stat_multiply`, `extra_projectile`, `aura`, all 8 spell no-holder no-ops | 12 |

**Total new tests: 35**

## Key decisions

1. **5th gap: progressionEffects over skillSystem dead code** — The `bonus===0` skip in
   `skillSystem` is genuinely dead code with current data (no skill has a 0-value bonus).
   Instead of testing unreachable code, tests for `progressionEffects.applyCatalogEffect`
   cover 12+ previously untested switch cases across the 563-line file.

2. **v1 fallback tests use real integration**: Rather than mocking `query()`, the v1 fallback
   tests spawn a real player entity and verify the ability is actually granted (or skipped
   when no player exists). This gives stronger confidence in the fallback behavior.

3. **Spell no-holder tests use real `CatalogEffect` shapes**: Initial implementation used
   `as never` with fake field names. Plan review caught this; fixed to use proper
   `ScalableOutput { base, scalesWithIntelligence }` field values for all 8 spell types.
   Tests also assert both `statModifiers.length` and `vfxEvents.length` unchanged.

## Review harness

- Apple tier: 3🍎
- Ledger: `docs/knowledge/review-ledgers/2026-07-23-ut-coverage-gaps.review-ledger.json`
- Plan review: gpt-5.4, 4 concerns raised, 4 resolved (plan_divergence: minor)
- Code review: claude-opus-4.8, 0 concerns (clean round 1)

## What wasn't addressed

- The `bonus===0` dead-code branch in `skillSystem` (line 64) — this can never fire with
  current skill data and would require a synthetic skill definition to test. Left for a
  future data-driven coverage pass if new skills ever use 0-value bonuses.
- `applyMilestone` with missing skill definition/milestone — also dead code since
  `getSkillDefinition` is pre-checked and all skills define milestones at 5/10/15/20.
