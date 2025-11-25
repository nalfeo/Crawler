# Handoff — Fireball targets any enemy, favoring clusters

**Date:** 2026-06-25
**Persona:** Producer (game systems — single-layer ability/effect change)
**Apples:** estimated 🍎🍎🍎 / actual 🍎🍎 (over — contained change with no schema migration or lab; one ADR added for the cross-layer design decision)

## Systems touched

enemies

## Task

The player **Fireball** spell used to wait for an enemy cluster (`enemy_cluster`,
`minEnemies: 2`) and then explode centered on the caster. The request: fire at
**any** enemy without waiting for a group, while still **prioritizing** groups in
range when they exist (non-exclusive).

## Change

- `src/game/abilities/registry.ts`
  - Fireball trigger `minEnemies: 2 → 1` so it auto-fires at a single enemy.
    Trigger range (`withinFeet: 6`) is unchanged, so _when_ it fires is the same.
- `src/game/abilities/types.ts`
  - Relaxed the `enemy_cluster` Zod schema `minEnemies` from `.min(2)` to `.min(1)`.
- `src/game/systems/progressionEffects.ts` — `castFireball()` rewritten from a
  self-centered blast to a **targeted** blast:
  - Candidate epicenters = living enemies within blast reach (`radiusPx`) of the caster.
  - Pick the candidate whose explosion catches the **most** enemies (group priority);
    tie-break by **proximity to the caster** (lone-enemy fallback → non-exclusive).
  - Explode at that point; knockback source = the chosen epicenter.
- `src/engine/scenes/MainGameScene.ts`
  - Updated the two fireball UI strings (trigger hint + ability description) from
    "enemy clusters (2+ targets)" / "clumps of enemies" to
    "hits the nearest enemy, favoring clusters".

## Why this approach

Kept it self-contained — no new effect fields or schema migration. The targeting
range reuses the existing AoE `radiusPx`, so once the spell trips (an enemy within
6 ft), it can still retarget onto a denser group within one blast-radius. The
trigger range was deliberately left at 6 ft to avoid a balance change to _when_ the
spell fires; only _where_ it lands changed. The weapon-def `fireball` (enemy AI
projectile) is a separate entity and was intentionally untouched.

## Tests

Added two unit tests in `tests/game/ability-system.test.ts`:

- Fires at a single nearby enemy (verifies `minEnemies: 1`).
- Prioritizes the densest cluster over a lone nearer enemy that merely triggered
  the cast (verifies group priority + non-exclusivity; the lone triggerer is spared
  when it sits outside the chosen blast).

## Validation

- `npm run verify:fast` ✅ (typecheck + lint + 203 unit tests)
- `npm run verify` ✅ (full suite: unit, coverage, integration, Floor 1 gate, build)
- Targeted: `vitest run tests/game/ability-system.test.ts tests/game/ability-registry.test.ts` ✅ (17 passed)

## Follow-ups / notes

- `files/guard-telemetry.jsonl` was not present this session, so no guard telemetry
  section was added.
- Possible future tuning: if the spell should also fire at enemies that are only
  within blast reach (6–12 ft) but outside the 6 ft trigger, bump the trigger
  `withinFeet` to match the blast radius. Left as-is to minimize balance drift.
