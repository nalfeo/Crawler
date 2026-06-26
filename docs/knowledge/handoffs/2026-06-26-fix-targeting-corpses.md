# 2026-06-26 — Fix: stop auto-aiming weapons at corpses

## Summary

User reported: "player is still swinging at and shooting at corpses!"

Root cause: `getNearestEnemyTarget` and `findBossTargetInRange` in `src/game/weaponSystem.ts` queried `[Enemy, Position]` without filtering dead entities. When an enemy dies, it keeps its `Enemy` + `Position` components during the death-linger window — `deathTimerSystem` only removes the entity after the corpse animation finishes. During that window the corpse stayed the strictly-nearest "target", so auto-fire and auto-swing locked onto the body while live enemies closed in.

`bt-ai-provider.findNearestEnemy` already gated `health <= 0`; `damageSystem.applyPlayerEnemyHit` already gated `DeathTimer` for contact damage. Only the weapon-system target picks were missing both gates.

## Fix

In both target-acquisition helpers, skip any enemy that has `DeathTimer` **or** whose `health.current <= 0`. Added `DeathTimer` + `Health` imports to `weaponSystem.ts`.

## Files touched

- `src/game/weaponSystem.ts` — corpse skip in `getNearestEnemyTarget` + `findBossTargetInRange`.
- `tests/game/weapon-system.test.ts` — two new tests:
  - ranged: corpse at +30px, live enemy at +80px → projectile aims at the live enemy.
  - melee: only a corpse in range → no `MeleeSwing` is spawned.

## Verification

`npm run verify:fast` → 311/311 pass (was 309 + 2 new tests). ~3.6s.

## Unresolved / next steps

- None for this scope. Consider a follow-up to also gate `enemyAISystem`'s target picks if any AI subsystems are observed targeting fresh corpses, but no current bug report supports that.

## Apple complexity

- Estimate: 🍎🍎
- Actual: 🍎🍎 (small surgical fix in two adjacent helpers, two unit tests, no scope creep).
- Verdict: on estimate.
