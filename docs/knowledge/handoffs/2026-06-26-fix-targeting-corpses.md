# 2026-06-26 — Fix: stop auto-aiming weapons at corpses

## Summary

User reported: "player is still swinging at and shooting at corpses!"

Root cause: `getNearestEnemyTarget` and `findBossTargetInRange` in `src/game/weaponSystem.ts` queried `[Enemy, Position]` without filtering dead entities. When an enemy dies, it keeps its `Enemy` + `Position` components during the death-linger window — `deathTimerSystem` only removes the entity after the corpse animation finishes. During that window the corpse stayed the strictly-nearest "target", so auto-fire and auto-swing locked onto the body while live enemies closed in.

`bt-ai-provider.findNearestEnemy` already gated `health <= 0`; `damageSystem.applyPlayerEnemyHit` already gated `DeathTimer` for contact damage. Only the weapon-system target picks were missing both gates.

## Fix

In both target-acquisition helpers, skip any enemy that has `DeathTimer` **or** whose `health.current <= 0`. Added `DeathTimer` + `Health` imports to `weaponSystem.ts`.

## Files touched

- `src/game/weaponSystem.ts` — corpse skip in `getNearestEnemyTarget` + `findBossTargetInRange`.
- `tests/game/weapon-system.test.ts` — original two tests:
  - ranged: corpse at +30px, live enemy at +80px → projectile aims at the live enemy.
  - melee: only a corpse in range → no `MeleeSwing` is spawned.

## Coverage follow-up (clearing the 80% branch gate)

The initial two tests gave the corpse **both** a `DeathTimer` and 0 HP, so the
`DeathTimer` guard short-circuited first and left the independent `Health`/`HP<=0`
branches uncovered. The per-file gate `src/game/weaponSystem.ts: { branches: 80 }`
landed at **79.5%** and the Unit Tests job went red.

Added three deterministic branch-coverage tests (still in `tests/game/weapon-system.test.ts`,
all using `createTestWorld()`, no `Math.random()`/`Date.now()`):

- `getNearestEnemyTarget` **Health-only corpse**: nearer enemy with `health.current=0`
  and **no** `DeathTimer`, plus a live enemy off-axis → projectile fires at the live
  enemy (exercises the `Health && current<=0` skip independent of `DeathTimer`).
- `findBossTargetInRange` **DeathTimer boss corpse**: permanently-aggroed boss
  (`aggroedPermanently=1`) with positive HP + a `DeathTimer` → skipped, fire falls
  back to the live nearest enemy.
- `findBossTargetInRange` **0-HP boss corpse**: permanently-aggroed boss with
  `health.current=0` and no `DeathTimer` → skipped, fire falls back to the live enemy.

Each test fails if its corresponding guard is removed (live enemy is placed on a
different axis from the corpse so the projectile velocity distinguishes the target).

## Verification

- `npx vitest run --project unit --coverage` (CI's Unit Tests command) → **188 files /
  2096 tests pass**, exit 0. `src/game/weaponSystem.ts` now **81% branches** (≥80 gate),
  93.5% statements, 100% funcs, 93.48% lines. No `Coverage for branches … threshold` error.
- `npm run typecheck`, `npm run lint`, `bash scripts/agent/lab-gate-check.sh` → all green.
- The headless/e2e perf-budget specs flake locally only under coverage-load (30s
  wall-clock guard); they pass on clean CI runners and this change is test-only.

## Unresolved / next steps

- None for this scope. Consider a follow-up to also gate `enemyAISystem`'s target picks if any AI subsystems are observed targeting fresh corpses, but no current bug report supports that.

## Apple complexity

- Estimate: 🍎🍎
- Actual: 🍎🍎 (small surgical fix in two adjacent helpers; initial two unit tests,
  plus a 🍎 coverage follow-up adding three branch-coverage tests to clear the 80%
  `weaponSystem.ts` branch gate — no production code changed in the follow-up).
- Verdict: on estimate.
