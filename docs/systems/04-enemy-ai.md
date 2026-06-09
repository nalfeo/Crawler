# Enemy AI & Spawner Systems

**Status:** ✅ Implemented  
**Layer:** `src/game/`  
**Labs:** `enemy-ai-lab`

---

## Systems in this group

| System               | File                             | Pipeline position |
| -------------------- | -------------------------------- | ----------------- |
| `enemyAISystem`      | `src/game/enemyAISystem.ts`      | preSystems        |
| `enemySpawnerSystem` | `src/game/enemySpawnerSystem.ts` | preSystems        |

---

## enemyAISystem

### What it does

Each step, for every `Enemy + EnemyBehavior` entity:

1. **Aggro check** — enemy enters combat state when player enters `aggroRange` or is hit (permanent aggro flag).
2. **AI persona dispatch** — runs one of three behaviours:
   - `CHASE` — A\* pathfinding, follow waypoints toward player.
   - `SWARM` — flocking (separation + cohesion + player attraction vectors).
   - `RANGED` — maintains flanking distance, pathfinds to flank position, fires projectile when `attackRange` reached.
3. **Stuck detection** — if velocity has been zero for `STUCK_FRAMES_THRESHOLD` frames, forces a path refresh.
4. **Shooting** — ranged enemies call `spawnEnemyProjectile` when in range and cooldown elapsed.

### Contract

```
Reads:   EnemyBehavior.{type, speed, aggroRange, attackRange, fireCooldownMs,
                        lastFireMs, persona, traversalMode, flankDistance,
                        pathRefreshFrames, aggroedPermanently, stuckFrames}
         Position.x/y (enemy + player)
         DoorState (pathfinding avoids closed doors)
         FloorMap (tile passability for A*)
         world.elapsedMs, world.rng
Writes:  Velocity.x/y (enemy movement direction × speed)
         enemyBehavior.lastFireMs, aggroedPermanently, stuckFrames
         spawnEnemyProjectile (ranged enemies)
Side effects: path cache stored in WeakMap per world
```

### AI type dispatch

```mermaid
flowchart TD
    ENE[Enemy entity]
    AGGRO{in aggroRange\nor permanently\naggroed?}
    IDLE[Velocity = 0]
    TYPE{EnemyBehavior.type}
    CHASE[CHASE persona\nA* path to player]
    SWARM[SWARM persona\nflocking vectors]
    RANGED[RANGED persona\nflank + shoot]

    ENE --> AGGRO
    AGGRO -- no --> IDLE
    AGGRO -- yes --> TYPE
    TYPE -- 0 --> CHASE
    TYPE -- 1 --> SWARM
    TYPE -- 2 --> RANGED
```

---

### CHASE persona (pathfinding)

```mermaid
flowchart TD
    CACHE{Path cache\nvalid & fresh?}
    FIND[findTilePath\nA* from enemy tile to player tile]
    NEXT[Pop next waypoint]
    STALE{Waypoint reached\nor path stale?]
    VEL[velocity = normalise(waypoint - pos) × speed]
    STUCK{stuckFrames >\nthreshold?}
    REFRESH[Force path refresh]

    CACHE -- yes --> NEXT
    CACHE -- no --> FIND
    FIND --> NEXT
    NEXT --> VEL
    VEL --> STALE
    STALE -- yes --> FIND
    STALE -- no --> STUCK
    STUCK -- yes --> REFRESH
    REFRESH --> FIND
```

### SWARM persona (flocking)

```mermaid
flowchart TD
    PLAYER[Vector to player × PLAYER_WEIGHT]
    NEIGHBORS[For each neighbor within SWARM_NEIGHBOR_RADIUS]
    SEP[Separation: push away × SEPARATION_WEIGHT]
    COH[Cohesion: pull toward centroid × COHESION_WEIGHT]
    SUM[Sum vectors, normalise, × speed]
    VEL[Velocity = result]

    PLAYER --> SUM
    NEIGHBORS --> SEP & COH
    SEP --> SUM
    COH --> SUM
    SUM --> VEL
```

### RANGED persona

```mermaid
flowchart TD
    FLANK[Compute flank position\n= player pos + perp offset × flankDistance]
    PATH[A* path to flank position]
    DIST{distance to player\n≤ attackRange?}
    FIRE{cooldown elapsed?}
    SHOOT[spawnEnemyProjectile\ntoward player]
    MOVE[Velocity toward next waypoint]

    PATH --> DIST
    DIST -- no --> MOVE
    DIST -- yes --> FIRE
    FIRE -- yes --> SHOOT
    FIRE -- no --> MOVE
    FLANK --> PATH
```

---

### PATH_PERSONA values

| Constant              | Value | Effect                           |
| --------------------- | ----- | -------------------------------- |
| `PATH_PERSONA.DIRECT` | 0     | Straight A\* to player           |
| `PATH_PERSONA.PATROL` | 1     | Patrol waypoints, aggro on sight |
| `PATH_PERSONA.AMBUSH` | 2     | Wait in room until player close  |

### TRAVERSAL_MODE values

| Constant                 | Value | Effect                                       |
| ------------------------ | ----- | -------------------------------------------- |
| `TRAVERSAL_MODE.GROUND`  | 0     | Standard tile pathfinding (doors block)      |
| `TRAVERSAL_MODE.FLYING`  | 1     | Ignores tile passability; straight-line move |
| `TRAVERSAL_MODE.PHASING` | 2     | Walks through walls (planned — not yet used) |

---

## enemySpawnerSystem

### What it does

Time-based enemy spawner. Every `spawnIntervalMs` it picks a random position inside the spawn bounds that:

1. Is not occupied by another enemy (overlap check).
2. Is not too close to the player.

Then calls `spawnEnemy` (from `src/core/helpers.ts`) and returns.

### Contract

```
Reads:   SpawnerConfig.{maxEnemies, spawnIntervalMs, enemyHp, enemySpeed}
         SpawnerBounds.{width, height}
         world.elapsedMs, world.rng
         Enemy query count (max cap)
         Player position (min spawn distance)
Writes:  SpawnerState.lastSpawnMs
         Spawns Enemy entities with Health + EnemyBehavior + Position + Velocity + Sprite
Side effects: new enemy entities in ECS
```

### Diagram

```mermaid
flowchart TD
    TICK{elapsedMs - lastSpawnMs\n≥ spawnIntervalMs?}
    CAP{enemy count\n< maxEnemies?}
    POS[Pick random position\nwithin bounds]
    OVERLAP{overlaps existing\nenemy?}
    PROX{too close\nto player?}
    SPAWN[spawnEnemy]
    UPDATE[lastSpawnMs = elapsedMs]
    RETRY[try new random pos\n(up to N attempts)]

    TICK -- no --> DONE[skip]
    TICK -- yes --> CAP
    CAP -- no --> DONE
    CAP -- yes --> POS
    POS --> OVERLAP
    OVERLAP -- yes --> RETRY
    OVERLAP -- no --> PROX
    PROX -- yes --> RETRY
    PROX -- no --> SPAWN
    SPAWN --> UPDATE
```

---

## Relationships to other systems

```mermaid
graph LR
    SPAWNER[enemySpawnerSystem] -->|creates| ENE[Enemy entities]
    AI[enemyAISystem] -->|reads| ENE
    AI -->|writes Velocity| MOV[movementSystem]
    AI -->|spawnEnemyProjectile| COL[collisionSystem]
    COL -->|pairs| DAM[damageSystem]
    DAM -->|hits player| HLT[healthSystem]
    DRP[dropSystem] -->|enemy @ 0HP| GEMS[XpGem + Gold + DroppedItem]
    GEMS --> PKP[itemPickupSystem]
    PKP -->|XP| LEVEL[levelSystem]
    PKP -->|gold| WORLD[world.playerGold]
```

---

## Floor 1 enemy director system

The Floor 1 scenario (`src/game/floor1Scenario.ts`) injects `floor1EnemyDirectorSystem` into `preSystems`. It manages a wave schedule, spawning `rat` and `slime` enemy species per the Floor 1 objective targets. It replaces `enemySpawnerSystem` for Floor 1 to give precise control over enemy mix and pacing.

```mermaid
sequenceDiagram
    participant DIR as floor1EnemyDirectorSystem
    participant OBJ as floor1ObjectiveSystem
    participant ENE as Enemy entities

    DIR->>ENE: spawn rats and slimes per wave schedule
    OBJ->>ENE: query dead enemies (health ≤ 0 before dropSystem runs)
    OBJ->>OBJ: increment ratsKilled / slimesKilled
    OBJ->>OBJ: check all objectives met → unlock staircase
```
