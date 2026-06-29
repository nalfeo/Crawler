/**
 * Backward-compatible facade over the entity-spawner modules.
 *
 * The spawner functions used to live here as one ~700-line god-module; they now
 * live in focused modules under `./spawners/`. This file re-exports them (plus
 * `applyDamage`) so every existing `../core/helpers.js` import keeps working
 * unchanged. New spawners should be added to the matching `./spawners/*` module,
 * not here.
 */
export { applyDamage } from './apply-damage.js';
export * from './spawners/index.js';
