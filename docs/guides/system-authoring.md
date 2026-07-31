# System Authoring Guide

This guide explains how to add a new ECS system using the project's bitecs 0.4 patterns.

## 1. Start with the paired lab

Before shipping the system, reserve or create its lab in `src/labs/<system>-lab/`. The system is not complete until the lab exists.

## 2. Add or update components

Define components using bitecs tag components plus typed-array stores.

```ts
export const Burn = {};
export const Burning = {};

// Store shape lives in createComponentStores():
// burn: { dps: new Float32Array(MAX_ENTITIES), remainingMs: new Float32Array(MAX_ENTITIES) }
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

- Most systems use `(world: GameWorld) => void`
- Pipeline systems may accept deterministic inputs and/or return deterministic outputs
- Read time from `world.elapsedMs` or frame progression, not `Date.now()`
- Read randomness from `world.rng`, not `Math.random()`
- Keep the system deterministic and side-effect-light

## 4. Register the system in the runner

Wire the system into the execution path that owns it (typically the engine scene update flow and any relevant lab entrypoint), and keep ordering explicit.

**A lab alone is not enough.** The orphaned-system wiring guard
(`npm run check:wired-systems`, ADR 0039) requires every `*System` exported from
`src/core/**` or `src/game/**` to be referenced by a real runtime wiring site:

- `src/bootstrap/floor-main-scene-options.ts`
- `src/core/simulation-core-step.ts`
- `src/engine/sim/simulation-step.ts`
- `src/game/ai/simulation-step.ts`
- `src/game/ai/headless-runner.ts`

…or explicitly allowlisted in `scripts/agent/health/orphaned-systems-lib.ts`
with a reason (only for systems intentionally not-yet-wired — never to silence
the gate). Lab references do not count. The `spawnerSystem` incident (ADR
0034 → 0036 → 0039) is why this rule exists.

Typical pattern:

```ts
import { burnSystem } from './burnSystem.js';
// Called from the scene or orchestration loop:
burnSystem(world);
```

Export through the nearest barrel (`src/core/systems/index.ts` or `src/game/systems/index.ts`) when that improves discoverability.

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
- `README.md` (recommended)

Expose meaningful lil-gui controls so designers can inspect the new system under different seeds and parameters.

## 8. Verify the change

Run:

```bash
npm run verify:fast
bash scripts/agent/lab-gate-check.sh
npm run verify:pr-prereqs
```

Reserve local full `npm run verify` runs for explicit human requests or targeted
diagnosis.

## 9. Final checklist

- Component definitions follow bitecs 0.4 style
- System lives in `src/core/systems/`
- System is registered in the runner
- Unit tests use `createTestWorld()`
- Property tests exist for important invariants
- Matching lab exists in `src/labs/`
- `verify:pr-prereqs` passes
