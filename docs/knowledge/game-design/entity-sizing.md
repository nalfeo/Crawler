# Entity sizing & weight — canonical values

> **This table is the source of truth.** `src/core/physics-defs.ts` mirrors it
> programmatically and `npm run check:physics-defs-sync` fails CI on drift.
> When you change a value here, update the mirror in the same commit.
>
> Related: ADR 0044, spec `.specify/specs/entity-physics.md`.

## Conventions

- All linear measurements are in **feet** (canonical spatial unit — ADR 0007/0023).
- **Weight** is in **pounds** (lb). Realistic-ish values so mental math works
  (e.g. a housecat is ~10 lb, an average man is ~180 lb, a granite boulder is
  ~600 lb per cubic foot × its volume).
- **Size shape**:
  - `circle` — one radius (`r`). Use for anything roughly round: mobs,
    projectiles, gems.
  - `box` — `w × h`. Use for anything obviously non-round: walls, doors,
    beams, oblong props.
- **Slice-1 rule:** the numeric values below are set equal to today's
  shipping sprite half-extents so `collision-pair-parity.test.ts` stays
  green when Slice 1 lands. Tuning happens in later slices, one at a time,
  with a win-rate sweep.

## Combatants

| Entity                     | Spawner                                 | Shape  | Size (ft) | Weight (lb) | Immovable | Notes                                                                         |
| -------------------------- | --------------------------------------- | ------ | --------- | ----------- | :-------: | ----------------------------------------------------------------------------- |
| Player                     | `spawners/combatants.ts` `spawnPlayer`  | circle | r = 1.5   | 180         |     —     | Sprite is 3×3 ft; half-extent 1.5 ft → radius 1.5.                            |
| Mob (default)              | `spawners/combatants.ts` `spawnEnemy`   | circle | r = 1.0   | 120         |     —     | Sprite 2×2. 120 lb baseline for knockback = 1.0×.                             |
| Mob — light (bat / slime)  | mob defs, `weight` field                | circle | r = 0.75  | 60          |     —     | 60 lb → 2× knockback vs baseline.                                             |
| Mob — heavy (ogre / brute) | mob defs, `weight` field                | circle | r = 1.25  | 240         |     —     | 240 lb → 0.5× knockback.                                                      |
| Mob — boss (Floor 1)       | mob defs, `weight` field                | box    | 3 × 3     | 800         |     —     | Sprite is bigger than hitbox in shipping build; TBD Slice 1 audit.            |
| NPC (quest giver, etc.)    | `spawners/combatants.ts` `spawnNpc`     | circle | r = 1.0   | 150         |    yes    | Never in `Knockback` query, so `Immovable` is a documentation-only assertion. |
| Spawner (structure)        | `spawners/combatants.ts` `spawnSpawner` | circle | r = 1.5   | 200         |    yes    | Weight already set to 200 today; formalized here.                             |

## Projectiles

| Entity              | Spawner                                     | Shape  | Size (ft)         | Weight (lb) | Notes                                                                           |
| ------------------- | ------------------------------------------- | ------ | ----------------- | ----------- | ------------------------------------------------------------------------------- |
| Bullet / arrow      | `spawners/projectiles.ts` `spawnProjectile` | circle | r = 0.375         | 1           | Sprite 0.75×0.75. Weight doesn't matter — projectiles aren't knockback targets. |
| Beam segment        | `spawners/projectiles.ts` `spawnBeam`       | box    | length × 0.25     | 1           | Length is set per-cast; only h fixed here.                                      |
| Melee swing (blade) | `spawners/melee.ts` `spawnMeleeSwing`       | circle | r ≈ `bladeLength` | 1           | Not a knockback target either; size drives the AABB the hash-grid inserts.      |
| Melee swing (head)  | `spawners/melee.ts`                         | circle | r = `radius`      | 1           | Bat head.                                                                       |

## Pickups & drops

| Entity       | Spawner                                  | Shape  | Size (ft) | Weight (lb) | Notes             |
| ------------ | ---------------------------------------- | ------ | --------- | ----------- | ----------------- |
| XP gem       | `spawners/pickups.ts` `spawnXpGem`       | circle | r = 0.5   | 1           |                   |
| Dropped item | `spawners/pickups.ts` `spawnDroppedItem` | circle | r = 0.5   | 1           |                   |
| Gold pile    | `spawners/pickups.ts` `spawnGold`        | circle | r = 0.625 | 5           | Sprite 1.25×1.25. |

## World objects

| Entity               | Spawner                                  | Shape  | Size (ft) | Weight (lb) | Immovable | Notes                                       |
| -------------------- | ---------------------------------------- | ------ | --------- | ----------- | :-------: | ------------------------------------------- |
| Wall segment         | `spawners/world-objects.ts` (varies)     | box    | 1 × 1     | 10 000      |    yes    | Match tile.                                 |
| Door                 | `spawners/world-objects.ts`              | box    | 1 × 1     | 500         |    yes    | Not in Knockback query today.               |
| Prop — small (torch) | `spawners/world-objects.ts` (decoration) | circle | r = 0.375 | 30          |    yes    | Uses `decorationDef.scale`.                 |
| Prop — barrel        | `spawners/world-objects.ts`              | circle | r = 0.75  | 60          |    no     | Optional Slice-2 goal: barrels punt on hit. |
| Trap                 | `spawners/world-objects.ts`              | circle | r = 0.5   | 100         |    yes    |                                             |
| Harvestable node     | `spawners/world-objects.ts`              | circle | r = 0.5   | 50          |    yes    |                                             |

## Knockback baseline math

The **median mob** is 120 lb. Slice 2's rule is:

```
knockback.speed[target]     = writerImpulse * (120 / max(1, targetWeight))
knockback.remaining[target] = knockback.speed[target]  // same as today
```

so a 120 lb mob's knockback is unchanged from today. `writerImpulse` values
(constants in `meleeSwingSystem`, `applyPlayerEnemyHit`, projectile impact,
area damage, corpse explosion) are the **same numeric literals** shipping
today — no per-writer recalibration is needed as long as the median target
matches, which is true for every enemy currently in the game (all default
to 120 lb).

`IMMOVABLE_THRESHOLD = 10 000` lb. Any target at or above this drops the
Knockback component immediately without moving. Also anything with the
`Immovable` tag component (added Slice 2).

## Coverage rules (enforced by CI)

- **`check:size-coverage`** (Slice 1): every entity in the collision grid
  has a `Size` with `radius > 0` OR (`halfWidth > 0` AND `halfHeight > 0`).
- **`check:weight-coverage`** (Slice 2): every entity with `Enemy`,
  `Player`, or `Prop` has `Weight.value > 0`.
- **`check:physics-defs-sync`** (Slice 1): every row in this table has a
  matching entry in `src/core/physics-defs.ts` with identical numeric values.
