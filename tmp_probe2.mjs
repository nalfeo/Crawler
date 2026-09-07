import { spawnPlayer } from './src/core/helpers.js';
import { getScenarioDefinition } from './src/game/scenarioDefinitions.js';
import { createTestWorld } from './tests/helpers/world-factory.js';
import { getActiveWeaponDef } from './src/core/active-weapon.js';

const world = createTestWorld({ seed: 4015 });
const player = spawnPlayer(world, 0, 0);
getScenarioDefinition('floor3').configureWorld(world, player);
console.log('activeWeapon after configureWorld:', getActiveWeaponDef(world)?.id);
console.log('state:', world.state);
