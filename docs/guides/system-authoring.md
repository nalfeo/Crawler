# System Authoring Guide

This guide explains how to add a new ECS system using the project's bitecs 0.4 patterns.

## 1. Start with the paired lab

Before shipping the system, reserve or create its lab in `src/labs/<system>-lab/`. The system is not complete until the lab exists.

## 2. Add or update components

Define components using the bitecs 0.4 plain-object schema style.

```ts
export const Burn = { dps: 0, remainingMs: 0 };
export const Burning = {};
```

Guidelines:

- Keep schemas minimal and data-oriented
- Use tag components for boolean state
- Add shared component definitions in the appropriate `src/core/` component module
- Never import Phaser or game-layer code into core

## 3. Create the system file

Place the system in `src/core/systems/`.

```text
src/core/systems/burnSystem.ts
```

Use the standard pure-function shape:

```ts
import { query } from 'bitecs';
import type { GameWorld } from '../world.js';
import { Burn, Health } from '../components.js';

export function burnSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Burn, Health]);

  for (const entity of entities) {
    // Apply deterministic state changes using world data only.
  }
}
```

Rules:

- Signature is `(world: GameWorld) => void`
- Read time from `world.elapsedMs` or frame progression, not `Date.now()`
- Read randomness from `world.rng`, not `Math.random()`
- Keep the system deterministic and side-effect-light

## 4. Register the system in the runner

Add the system to the canonical system runner so it executes in the intended order.

Typical pattern:

```ts
import { burnSystem } from './burnSystem.js';

export const coreSystems = [burnSystem];
```

If a runner file does not exist yet, create a single explicit registry rather than scattering system startup across the codebase.

## 5. Write unit tests

Use `createTestWorld()` from `tests/helpers/world-factory.ts`.

```ts
import { createTestWorld } from '../helpers/world-factory.js';
import { burnSystem } from '../../src/core/systems/burnSystem.js';

it('applies burn damage deterministically', () => {
  const world = createTestWorld({ seed: 42 });
  burnSystem(world);
  // assertions
});
```

Test expectations:

- happy path behavior
- edge cases
- deterministic outcomes for the same seed
- no unintended mutation outside the system's scope

## 6. Add property-based invariants when needed

If the system affects combat, economy, spawning, movement, or progression, add property-based tests for the relevant invariant.

Examples:

- health never goes below zero
- velocity clamps remain within bounds
- item counts never become negative
- the same seed produces the same result sequence

## 7. Create the corresponding lab

Build `src/labs/<system>-lab/` with:

- `index.ts`
- `config.ts`
- `README.md`

Expose meaningful lil-gui controls so designers can inspect the new system under different seeds and parameters.

## 8. Verify the change

Run:

```bash
npm run verify:fast
bash scripts/agent/lab-gate-check.sh
npm run verify
```

## 9. Final checklist

- Component definitions follow bitecs 0.4 style
- System lives in `src/core/systems/`
- System is registered in the runner
- Unit tests use `createTestWorld()`
- Property tests exist for important invariants
- Matching lab exists in `src/labs/`
- Full verification passes
