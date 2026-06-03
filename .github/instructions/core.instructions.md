---
applyTo: 'src/core/**'
---

# Core Layer Instructions

This is the pure ECS layer. ALL game logic lives here as bitecs systems.

## Rules

- NO imports from `src/engine/`, `src/game/`, or `src/labs/`
- Only import from `src/shared/` and `bitecs`
- Systems are pure functions: `(world: GameWorld) => void`
- Components are plain objects (bitecs 0.4 API)
- Use `addComponent`, `removeComponent`, `query`, `addEntity` from bitecs
- Every system must have unit tests in `tests/ecs/`
- Every system must have a lab in `src/labs/`

## Component Pattern (bitecs 0.4)

```typescript
// Components are plain object schemas
export const Position = { x: 0, y: 0 };
export const Health = { current: 100, max: 100 };
export const Player = {}; // tag component

// Usage in systems:
import { query, addComponent, set } from 'bitecs';
const entities = query(world.ecs, [Position, Velocity]);
```

## Testing Pattern

```typescript
import { createTestWorld } from '../../tests/helpers/world-factory';
const world = createTestWorld({ seed: 42 });
// Add entities, run system, assert state
```
