# Movement & Input Systems

**Status:** ✅ Implemented  
**Layer:** `src/core/systems/` + `src/engine/InputCapture.ts`  
**Lab:** `movement-lab`, `playerinput-lab`, `collision-lab`

---

## Systems in this group

| System              | File                                    | Runs at                       |
| ------------------- | --------------------------------------- | ----------------------------- |
| `InputCapture`      | `src/engine/InputCapture.ts`            | every Phaser frame (pre-step) |
| `playerInputSystem` | `src/core/systems/playerInputSystem.ts` | step 1 of pipeline            |
| `movementSystem`    | `src/core/systems/movementSystem.ts`    | step 3                        |
| `collisionSystem`   | `src/core/systems/collisionSystem.ts`   | step 4                        |

---

## InputCapture

### What it does

Bridges Phaser's keyboard events and mobile touch joystick into the shared `InputState` struct. Runs once per Phaser render frame before the fixed-step simulation.

### Contract

```
Inputs:  Phaser.Scene keyboard events + pointer/touch events
Outputs: InputState { moveX, moveY, aimX, aimY, shootHeld, ... }
```

### Diagram

```mermaid
graph LR
    KB[Keyboard\nWASD / Arrow keys]
    TC[Touch joystick\nmobile controls]
    IC[InputCapture.poll]
    IS[InputState\nmoveX · moveY\naimX · aimY\nshootHeld]

    KB --> IC
    TC --> IC
    IC --> IS
    IS -->|passed to| PIS[playerInputSystem]
    IS -->|stored in| WS[weaponSystem]
```

---

## playerInputSystem

### What it does

Reads `InputState.moveX/moveY` (already normalised to unit length) and writes the player entity's `Velocity` component. Uses `Stats.moveSpeed` when the `Stats` component is present, otherwise falls back to `PLAYER_SPEED`.

### Contract

```
Reads:   InputState, Stats.moveSpeed (optional)
Writes:  Velocity.x, Velocity.y for all entities with [Player, Velocity]
Side effects: none
```

### Diagram

```mermaid
flowchart TD
    INP[InputState\nmoveX · moveY\nnormalised direction]
    Q[query Player + Velocity]
    SPEED{has Stats\ncomponent?}
    USE_STAT[moveSpeed = Stats.moveSpeed]
    USE_CONST[moveSpeed = PLAYER_SPEED]
    SETVX[Velocity.x = moveX × moveSpeed]
    SETVY[Velocity.y = moveY × moveSpeed]

    INP --> Q
    Q --> SPEED
    SPEED -- yes --> USE_STAT
    SPEED -- no --> USE_CONST
    USE_STAT --> SETVX
    USE_CONST --> SETVX
    SETVX --> SETVY
```

---

## movementSystem

### What it does

Applies `Velocity` to `Position` each simulation step. If a `FloorMap` is loaded it performs tile-level slide-collision: tries the full move first, then X-only, then Y-only. Flying entities only respect map bounds, not wall tiles.

### Contract

```
Reads:   Position.x/y, Velocity.x/y, FloorMap.isPassableAt()
Writes:  Position.x, Position.y
Side effects: none (pure transform, no entities created/destroyed)
```

### Diagram

```mermaid
flowchart TD
    Q[query Position + Velocity]
    CALC[newX = pos.x + vel.x\nnewY = pos.y + vel.y]
    MAP{floorMap\nloaded?}
    FLY{Flying\ncomponent?}
    BOUNDS[Clamp to map bounds only]
    FULL{isPassable\nnewX, newY?}
    XONLY{isPassable\nnewX, oldY?}
    YONLY{isPassable\noldX, newY?}
    MOVE_FULL[pos = newX, newY]
    MOVE_X[pos.x = newX]
    MOVE_Y[pos.y = newY]
    STUCK[Stuck — no move]
    FREE[Unrestricted move\nno map loaded]

    Q --> CALC
    CALC --> MAP
    MAP -- no --> FREE
    MAP -- yes --> FLY
    FLY -- yes --> BOUNDS
    FLY -- no --> FULL
    FULL -- yes --> MOVE_FULL
    FULL -- no --> XONLY
    XONLY -- yes --> MOVE_X
    XONLY -- no --> YONLY
    YONLY -- yes --> MOVE_Y
    YONLY -- no --> STUCK
```

---

## collisionSystem

### What it does

Inserts every entity with `[Position, Sprite]` into a `SpatialHashGrid` (cell size = 64 px), then runs `queryPairs()` to produce all overlapping AABB pairs this frame. The result is passed by value to `damageSystem`, `areaDamageSystem`, `trapSystem`, and `itemPickupSystem`.

### Contract

```
Reads:   Position.x/y, Sprite.width/height for all entities with [Position, Sprite]
Returns: CollisionResult { pairs: CollisionPair[], grid: SpatialHashGrid }
  CollisionPair { a: eid, b: eid }  — always a < b (deduplicated)
Side effects: clears and rebuilds the shared SpatialHashGrid each step
```

### Diagram

```mermaid
graph TD
    Q[query Position + Sprite]
    GRID[SpatialHashGrid.clear]
    INSERT[insert each entity\nAABB = pos ± sprite half-size]
    PAIRS[queryPairs\nnormalise a < b\ndeduplicate via Set]
    RESULT[CollisionResult\npairs · grid]

    Q --> GRID
    GRID --> INSERT
    INSERT --> PAIRS
    PAIRS --> RESULT
    RESULT -->|pairs| DAM[damageSystem]
    RESULT -->|pairs| AREA[areaDamageSystem]
    RESULT -->|pairs + grid| TRP[trapSystem]
    RESULT -->|pairs| PKP[itemPickupSystem]
```

### SpatialHashGrid internals

```mermaid
graph LR
    CELL["Cell (cx, cy)\n= floor(x / cellSize), floor(y / cellSize)"]
    BUCKET["Bucket: Set[eid]"]
    QUERY["queryPairs:\nfor each entity, check its 3×3 neighbourhood\ntest AABB overlap for each neighbour\nemit pair once (a < b)"]

    CELL --> BUCKET
    BUCKET --> QUERY
```

---

## How these systems relate to the rest of the pipeline

```mermaid
sequenceDiagram
    participant IC as InputCapture
    participant PI as playerInputSystem
    participant MV as movementSystem
    participant CL as collisionSystem
    participant DS as damageSystem
    participant WS as weaponSystem

    IC->>PI: InputState (moveX/Y, aimX/Y)
    PI->>MV: sets Velocity for player
    WS->>MV: sets Velocity for projectiles (spawned in preSystems)
    MV->>CL: entities have updated positions
    CL->>DS: CollisionResult.pairs
    CL->>DS: CollisionResult.grid (for radius queries)
```
