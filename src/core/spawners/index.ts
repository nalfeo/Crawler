/**
 * Barrel for the entity-spawner modules.
 *
 * `src/core/helpers.ts` re-exports everything here so existing call sites keep
 * importing spawners from `../core/helpers.js` unchanged. Group new spawners
 * into the cohesive module that matches their domain.
 */
export * from './entity-core.js';
export * from './combatants.js';
export * from './companions.js';
export * from './pickups.js';
export * from './projectiles.js';
export * from './melee.js';
export * from './world-objects.js';
