# Lab Authoring Guide

This guide explains how to create a new lab for a gameplay or ECS system.

## 1. Pick the lab name

Use the system name as the base and create a sibling directory under `src/labs/`.

```text
src/labs/<system>-lab/
```

Examples:

- `movement` → `src/labs/movement-lab/`
- `drop` → `src/labs/drop-lab/`

## 2. Create the required files

Every lab must include `index.ts`. A lab `README.md` is strongly recommended.

```text
src/labs/<system>-lab/
├── index.ts
└── README.md (recommended)
```

- `index.ts` is the lab entry point and calls `registerLab(...)`
- `README.md` explains what the lab demonstrates and how to use it

## 3. Define the lab config

Put all designer-tunable values in `config.ts`.

```ts
export const movementLabConfig = {
  speed: 120,
  enemyCount: 25,
  spawnRadius: 300,
};
```

Keep the config serializable and easy to reset so seeded reproduction is simple.

## 4. Build the lab entry point

`index.ts` should:

- create or mount the lab scene
- load the system under test
- apply the config values
- expose a clean setup/teardown path

Typical responsibilities include seeding the world, spawning representative entities, wiring update loops, and showing visible debug output.

## 5. Register the lab in the framework

Register the new lab in the loader path map used by `src/lab-main.ts`, then register its metadata in `src/labs/registry.ts` via `registerLab(...)`.

A typical lab entry point registration looks like this:

```ts
import { registerLab } from '../registry.js';

function createMovementLab(canvas: HTMLElement, controls: HTMLElement): (() => void) | void {
  // Lab setup logic lives in index.ts in current labs.
  // Return a cleanup callback if the lab allocates resources.
}

registerLab('movement-lab', {
  name: 'Movement Lab',
  description: 'Prototype movement tuning.',
  category: 'Movement & Physics',
  create: createMovementLab,
});
```

The key must match the URL used by the lab loader:

```text
?lab=movement-lab
```

## 6. Add lil-gui controls

Labs must use `lil-gui` for live tuning.

Typical control setup:

```ts
import GUI from 'lil-gui';
import { movementLabConfig } from './config.js';

const gui = new GUI();
gui.add(movementLabConfig, 'speed', 10, 300, 1);
gui.add(movementLabConfig, 'enemyCount', 1, 200, 1);
gui.add(movementLabConfig, 'spawnRadius', 50, 800, 10);
```

Use control ranges that reflect real design limits, not arbitrary values.

## 7. Write the README

Document:

- the system being explored
- the controls exposed in lil-gui
- expected behaviors and edge cases
- how to reproduce interesting scenarios

## 8. Test the lab

Minimum verification:

1. Run `npm run lab`
2. Open the lab URL with `?lab=<name>`
3. Confirm the lab loads without manual code edits
4. Confirm lil-gui controls change the simulation live
5. Confirm the lab still works after restarting the dev server

## 9. Final checklist

- Lab folder exists in `src/labs/`
- `index.ts` is present (`README.md` recommended)
- Lab is listed in `LAB_MODULE_PATHS` in `src/lab-main.ts`
- Lab calls `registerLab(...)` from its `index.ts`
- Lab loads via `?lab=<name>`
- lil-gui controls are useful and safe
- The paired system can now satisfy the lab gate policy
