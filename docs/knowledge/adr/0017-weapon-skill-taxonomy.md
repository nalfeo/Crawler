# ADR-0017: Weapon Skill Taxonomy — Class + Type Skills with Accuracy System

## Status

Accepted

## Context

The game design calls for a combat skills system where weapons contribute to player progression in two tiers:

1. **Weapon Class skills** (Slashing, Stabbing, Smashing, Ranged, Forearms) — broad attack style, grant damage bonuses, level more slowly.
2. **Weapon Type skills** (Sword, Dagger, Sports Equipment, Bow, Crossbow, Pistol, Heavy Weapon, Thrown) — specific weapon family, grant accuracy bonuses, level faster.

The system also needed an **accuracy mechanic** — weapons have a base accuracy stat, and player dexterity plus weapon type skill level modify final shot spread.

Balance target: type skill reaches level 4 by end of floor 1 (~150 uses); class skill reaches level 2 by the same point.

## Decision

### Skill taxonomy

Two new `SkillDefinition` categories — `weapon_class` and `weapon_type` — added alongside the existing `combat | defense | utility` categories. This reuses the entire existing skill pipeline (registry, skillSystem, statsSystem modifiers) with no new ECS components.

### WeaponDef extension

Three fields added to `WeaponDef`:

- `classSkillId: WeaponClassSkillId | null` — which class skill this weapon exercises.
- `typeSkillId: WeaponTypeSkillId | null` — which type skill this weapon exercises.
- `baseAccuracy: number` — base accuracy 0–1 (1.0 = perfect, no spread).

All existing weapons updated with appropriate tags and `baseAccuracy` values (0.6–1.0 depending on weapon type).

### Skill progression

Skill events are emitted from `weaponSystem.dispatchAttack()` immediately after each attack fires — one event per class skill + one per type skill, metric `hits_landed`, amount 1. This matches the design intent ("level up by using items/abilities") without requiring confirmed-hit tracking from core systems.

**Why fire events on fire, not confirmed hit:** The core damage systems (`damageSystem`, `meleeSwingSystem`) live in `src/core/` which cannot import from `src/game/`. Plumbing hit confirmation back to the game layer would require significant ECS additions. Firing on weapon use is consistent with the design text ("using items") and keeps the system simple.

### Usage thresholds (balance)

Type skill thresholds: `[10, 30, 70, 150, 280, ...]` — level 4 at 150 uses.
Class skill thresholds: `[40, 150, 340, 600, ...]` — level 2 at 150 uses.
Class threshold[1] (150) ≥ type threshold[3] (150) — they're equal at floor 1, then class grows much steeper.

### Accuracy system

`computeAccuracy(world, playerEid, weaponDef)` computes:

```
accuracy = baseAccuracy
         + dex × DEX_ACCURACY_BONUS_PER_POINT (0.015/point)
         + typeSkillLevel × TYPE_SKILL_ACCURACY_BONUS_PER_LEVEL (0.01/level)
```

Clamped [0, 1].

`applyAccuracySpread(dir, accuracy, world)` applies angular spread:

```
spread = (rng.next() * 2 - 1) × (1 - accuracy) × MAX_ACCURACY_SPREAD_RAD (0.45 rad ≈ 25°)
```

Uses `world.rng` for determinism. Melee and trap attacks are excluded (swing arc handles spread).

### UX

`HudSkillsPanel` added to the bottom-right HUD corner. Shows the active weapon's class and type skill as labelled progress bars. Hidden when no data-driven weapon is active. Reads `world.activeWeaponId` (newly added to `GameWorld`) so the engine layer needs no direct import from `src/game/`.

`world.activeWeaponId` is set by `setActiveWeapon`/`clearActiveWeapon` in `weaponSystem.ts` and initialized to `null` in `createGameWorld`.

## Consequences

- All 15 existing weapons now have `classSkillId`, `typeSkillId`, and `baseAccuracy`.
- 13 new skill definitions (5 class + 8 type) in the registry; all validated by existing Zod schema.
- One existing test (`ranged-weapons.test.ts`) updated: velocity exact-equality → speed magnitude check, because accuracy spread now modifies projectile direction.
- Determinism preserved: spread uses `world.rng` (SeededRandom).
- Future skill types (crossbow, pistol, etc.) and weapon types that share class/type IDs will automatically benefit without code changes.
