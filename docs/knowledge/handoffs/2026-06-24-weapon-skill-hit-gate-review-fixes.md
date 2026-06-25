# Handoff — Weapon Skill Hit-Gate Review Fixes

**Date:** 2026-06-24  
**Session:** weapon-skill-hit-gate-review-fixes  
**Persona:** Producer  
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** exact

## What Was Done

Shepherded PR #281 ("feat: weapon skills only gain XP on hit and damage")
through its review-fix cycle. Addressed all three Copilot reviewer threads,
strengthened test coverage, and drove the PR to a mergeable state.

## Review Threads Addressed (3/3 resolved)

1. **Vacuous miss test** (`tests/game/weapon-skills.test.ts`) — the
   "no skill XP on missed attack" test never exercised the accuracy roll: a
   MELEE sword with no enemy in range made `weaponSystem` return early before
   `dispatchAttack`, so the miss branch was never hit. Fixed by spawning an
   enemy in range, forcing `world.rng.next = () => 1.0` (guaranteed miss
   against sword `baseAccuracy: 0.9`), and asserting a `'miss'` combat event
   fires alongside the existing no-skill-event / empty-map assertions.

2. **Per-attacker keying limitation** (`src/game/weaponSystem.ts`) —
   `world.attackerWeaponSkills` is keyed by attacker EID, so switching weapons
   while a projectile/beam is mid-flight can misattribute the in-flight hit's
   XP to the newly equipped weapon's skills. This is an acknowledged edge-case
   non-blocker (requires a per-attack snapshot threaded through 4 systems plus
   AoE propagation — warrants its own ADR). Documented inline above the
   `attackerWeaponSkills.set(...)` call and filed tracking issue **#292**.

3. **Untested hit-gated XP branches** (`src/core/systems/damageSystem.ts`) —
   the projectile / beam / area-damage hit-gated XP paths (the `ownerEid !== -1`
   guard) had no direct branch coverage. Added describe blocks to the three
   `tests/ecs/*-branches.test.ts` files covering both the positive
   (player-owned hit emits `weapon_fired` events) and negative
   (owner-less projectile via the `-1` guard, and owner-without-registered-skills)
   cases.

## Files Changed (commit on top of the original feature work)

| File                                            | Change                                               |
| ----------------------------------------------- | ---------------------------------------------------- |
| `tests/game/weapon-skills.test.ts`              | Non-vacuous miss test (spawns enemy, asserts `miss`) |
| `tests/ecs/damage-system-branches.test.ts`      | +3 hit-gated projectile XP branch tests              |
| `tests/ecs/beam-system-branches.test.ts`        | +2 hit-gated beam XP branch tests                    |
| `tests/ecs/area-damage-system-branches.test.ts` | +2 hit-gated area XP branch tests                    |
| `src/game/weaponSystem.ts`                      | Inline comment documenting per-attacker keying limit |

## Notes for Next Agent

- **Issue #292** tracks the per-attack attribution refactor (weapon-switch
  mid-flight misattribution). It needs an ADR — the snapshot must thread through
  melee/projectile/beam/area systems and survive AoE propagation.
- **Flaky test (not mine):** `tests/unit/sprites/score-candidate.test.ts`
  ("a solid-block fixture fails the opaque-ratio sensor") can time out at 30s
  under full parallel `npm run verify` (CPU-heavy image processing,
  ~800–1000ms/test). It passes cleanly in isolation (21 tests). Environment
  load flake — do not "fix" it as part of unrelated work.
- **Determinism preserved:** all new tests use `createTestWorld()` (seed 42)
  and `world.rng`; no `Math.random()` / `Date.now()` introduced.
