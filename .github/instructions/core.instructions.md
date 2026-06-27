---
applyTo: 'src/core/**'
---

# Core Layer Instructions

This is the pure ECS layer. ALL game logic lives here as bitecs systems.

## Rules

- NO imports from `src/engine/`, `src/game/`, or `src/labs/`
- Imports from `src/shared/` and approved third-party dependencies are allowed
- Systems are deterministic and pure with respect to input state (most are `(world: GameWorld) => void`)
- Some pipeline systems may accept deterministic inputs or return deterministic outputs
- Components are tag identity objects; component data lives in typed-array stores on `world.stores`
- Every system must have unit tests in `tests/ecs/`
- Every system must have a lab in `src/labs/`
- **Declare apple complexity** before starting: 🍎–🍎🍎🍎🍎🍎 per `docs/agent-os/policies/complexity-policy.md`

## Component Pattern (bitecs 0.4)

```typescript
// Components are identity tags
export const Position = {};
export const Health = {};
export const Player = {}; // tag component

// Data lives in world.stores typed arrays:
// world.stores.position.x[eid]
// world.stores.health.current[eid]

// Usage in systems:
import { query } from 'bitecs';
const entities = query(world.ecs, [Position, Velocity]);
```

## Testing Pattern

```typescript
import { createTestWorld } from '../../tests/helpers/world-factory';
const world = createTestWorld({ seed: 42 });
// Add entities, run system, assert state
```

> Layer boundaries are enforced by `eslint.config.js`. See `docs/README.md` for
> the governance source-of-truth registry and `docs/architecture.md` for the
> systems catalogue.
