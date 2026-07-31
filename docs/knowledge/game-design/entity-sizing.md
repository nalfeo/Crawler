# Entity sizing & weight — canonical values

> **This sheet is the review/reference view, not the authoring home for mob
> rows.** `src/core/physics-defs.ts` is the composed runtime view and
> `npm run check:physics-defs-sync` fails CI on drift between authored defs,
> the runtime composition, and this sheet. For mobs, edit the mob
> definition where sprite/stats/AI data already lives.
>
> Related: ADR 0044, spec `.specify/specs/entity-physics.md`.

## Conventions

- All linear measurements are in **feet** (canonical spatial unit — ADR 0007/0023).
- **Weight** is in **pounds** (lb). Realistic-ish values so mental math works
  (e.g. a housecat is ~10 lb, an average man is ~180 lb, and granite runs
  ~168 lb per cubic foot × the boulder's volume).
- **Mob authoring rule**: each mob definition owns its default body size,
  default weight, and allowed variance range beside sprite/stats/AI
  metadata. This sheet summarizes those values for review; it is not the
  primary edit surface for mobs.
- **Variance range** means the authored min/max band around a mob's default
  body values (size/weight). Slice 1 may keep that band zero-width
  (`min = default = max`) so the migration stays bit-identical while still
  reserving a per-mob home for future variation.
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

| Entity                   | Spawner                                                                              | Shape   | Size (ft) | Weight (lb) | Immovable | Notes                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------ | ------- | --------- | ----------- | :-------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| Player                   | `spawners/combatants.ts` `spawnPlayer`                                               | circle  | r = 1.5   | 180         |     —     | Sprite is 3×3 ft; half-extent 1.5 ft → radius 1.5.                                                                                     |
| Mob (per definition)     | current mob-definition entries (`src/game/spawners/registry.ts` `MobTemplate` today) | per def | per def   | per def     |     —     | Author each mob's default size, default weight, and allowed variance range in the current mob-definition entry beside sprite/stats/AI. |
| Mob — baseline guideline | mob definition body fields                                                           | circle  | r ≈ 1.0   | 120         |     —     | Review heuristic only. 120 lb stays the knockback 1.0× baseline unless a mob def overrides it.                                         |
| Mob — light guideline    | mob definition body fields                                                           | circle  | r ≈ 0.75  | 60          |     —     | Example review band only; concrete values/variance still live on the mob def.                                                          |
| Mob — heavy guideline    | mob definition body fields                                                           | circle  | r ≈ 1.25  | 240         |     —     | Example review band only; concrete values/variance still live on the mob def.                                                          |
| Mob — boss guideline     | mob definition body fields                                                           | box     | ≈ 3 × 3   | 800         |     —     | Example review band only; Floor 1 boss still needs a per-def Slice-1 audit.                                                            |
| NPC (quest giver, etc.)  | `spawners/world-objects.ts` `spawnNpc`                                               | circle  | r = 1.0   | 150         |    yes    | Never in `Knockback` query, so `Immovable` is a documentation-only assertion.                                                          |
| Spawner (structure)      | `spawners/combatants.ts` `spawnSpawner`                                              | circle  | r = 1.5   | 200         |    yes    | Weight already set to 200 today; formalized here.                                                                                      |

## Projectiles

| Entity              | Spawner                                     | Shape  | Size (ft)         | Weight (lb) | Notes                                                                                  |
| ------------------- | ------------------------------------------- | ------ | ----------------- | ----------- | -------------------------------------------------------------------------------------- |
| Bullet / arrow      | `spawners/projectiles.ts` `spawnProjectile` | circle | r = 0.375         | 1           | Sprite 0.75×0.75. Weight doesn't matter — projectiles aren't knockback targets.        |
| Beam segment        | `spawners/projectiles.ts` `spawnBeam`       | box    | length × 0.5      | 1           | Length is set per-cast; only h fixed here (sprite height 0.5 ft, half-extent 0.25 ft). |
| Melee swing (blade) | `spawners/melee.ts` `spawnMeleeSwing`       | circle | r ≈ `bladeLength` | 1           | Not a knockback target either; size drives the AABB the hash-grid inserts.             |
| Melee swing (head)  | `spawners/melee.ts`                         | circle | r = `radius`      | 1           | Bat head.                                                                              |

## Pickups & drops

| Entity       | Spawner                                  | Shape  | Size (ft) | Weight (lb) | Notes                                                                                         |
| ------------ | ---------------------------------------- | ------ | --------- | ----------- | --------------------------------------------------------------------------------------------- |
| XP gem       | `spawners/pickups.ts` `spawnXpGem`       | circle | r = 0.5   | 1           |                                                                                               |
| Dropped item | `spawners/pickups.ts` `spawnDroppedItem` | circle | r = 0.625 | 5           | Sprite 1.25×1.25.                                                                             |
| Gold pile    | `spawners/pickups.ts` `spawnGold`        | circle | r = 0.5   | 1           | Sprite 1×1 today; larger sprite (1.25×1.25 → r=0.625) is a candidate retune in a later slice. |

## World objects

| Entity               | Spawner                                  | Shape  | Size (ft) | Weight (lb) | Immovable | Notes                                                                                   |
| -------------------- | ---------------------------------------- | ------ | --------- | ----------- | :-------: | --------------------------------------------------------------------------------------- |
| Wall segment         | `spawners/world-objects.ts` (varies)     | box    | 1 × 1     | 10 000      |    yes    | Match tile.                                                                             |
| Door                 | `spawners/world-objects.ts`              | box    | 1 × 1     | 500         |    yes    | Not in Knockback query today.                                                           |
| Prop — small (torch) | `spawners/world-objects.ts` (decoration) | circle | r = 0.375 | 30          |    yes    | Uses `decorationDef.scale`.                                                             |
| Prop — barrel        | `spawners/world-objects.ts`              | circle | r = 0.75  | 60          |    no     | Optional Slice-2 goal: barrels punt on hit.                                             |
| Trap                 | `spawners/world-objects.ts`              | circle | r = 0.75  | 100         |    yes    | Sprite 1.5×1.5 today; not a knockback target, `weight` is nominal for the sync sheet.   |
| Harvestable node     | `spawners/world-objects.ts`              | circle | r = 0.5   | 50          |    yes    |                                                                                         |
| Boss chest           | `spawners/world-objects.ts`              | circle | r = 1.0   | 10 000      |    yes    | Immovable; opened by proximity not collision. Proximity trigger is BOSS_CHEST_RANGE_FT. |

## Knockback baseline math

The **median mob** is 120 lb. Slice 2's rule is:

```
weightScale                 = min(KNOCKBACK_WEIGHT_SCALE_MAX, 120 / max(1, targetWeight))
knockback.speed[target]     = writerImpulse * weightScale
knockback.remaining[target] = knockback.speed[target]  // same as today
```

`KNOCKBACK_WEIGHT_SCALE_MAX = 2.5` (see `src/core/physics-defs.ts`).
The cap keeps ultra-light authored mobs from getting punted absurd
distances — without it a rat @ 6 lb would receive 20× displacement.

so a 120 lb mob's knockback is unchanged from today. `writerImpulse` values
(constants in `meleeSwingSystem`, `applyPlayerEnemyHit`, projectile impact,
area damage, corpse explosion) are the **same numeric literals** shipping
today — no per-writer recalibration is needed as long as the median target
matches, which is true for every enemy currently in the game (all default
to 120 lb).

Worked examples (see also `src/game/spawners/registry.ts` for authored
weights per mob):

| Target       | Weight (lb) | Raw scale | Clamped scale | Notes                                   |
| ------------ | ----------- | --------- | ------------- | --------------------------------------- |
| Rat          | 6           | 20.0×     | **2.5×**      | Clamped by KNOCKBACK_WEIGHT_SCALE_MAX   |
| Slime        | 20          | 6.0×      | **2.5×**      | Clamped                                 |
| Brute (mini) | 30          | 4.0×      | **2.5×**      | Clamped                                 |
| 48 lb        | 48          | 2.5×      | 2.5×          | Cap boundary — linear at or above       |
| Light mob    | 60          | 2.0×      | 2.0×          | Below cap                               |
| Median mob   | 120         | 1.0×      | 1.0×          | Identity (bit-parity vs pre-Slice-2)    |
| Ogre         | 240         | 0.5×      | 0.5×          |                                         |
| Boss         | 800         | 0.15×     | 0.15×         |                                         |
| Wall/statue  | ≥ 10 000    | —         | 0             | Short-circuited via IMMOVABLE_THRESHOLD |

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
