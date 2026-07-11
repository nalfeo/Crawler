/**
 * Facade contract for `src/core/helpers.ts`.
 *
 * The spawner implementations now live in focused modules under
 * `src/core/spawners/`; `helpers.ts` is a thin re-export barrel kept so existing
 * `../core/helpers.js` call sites stay byte-for-byte unchanged. These tests lock
 * that contract: every public symbol must still be reachable through the facade
 * AND be the exact same reference as the owning module's export (reference
 * identity guarantees identical behavior). Per-spawner behavior is covered in
 * `tests/ecs/spawners/*`.
 */
import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Player } from '../../src/core/components.js';
import * as helpers from '../../src/core/helpers.js';
import { applyDamage } from '../../src/core/apply-damage.js';
import * as entityCore from '../../src/core/spawners/entity-core.js';
import * as combatants from '../../src/core/spawners/combatants.js';
import * as pickups from '../../src/core/spawners/pickups.js';
import * as projectiles from '../../src/core/spawners/projectiles.js';
import * as melee from '../../src/core/spawners/melee.js';
import * as worldObjects from '../../src/core/spawners/world-objects.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('helpers facade', () => {
  it('re-exports every spawner module symbol by reference identity', () => {
    const modules = [entityCore, combatants, pickups, projectiles, melee, worldObjects];
    for (const mod of modules) {
      for (const [name, value] of Object.entries(mod)) {
        expect((helpers as Record<string, unknown>)[name]).toBe(value);
      }
    }
  });

  it('re-exports applyDamage from apply-damage', () => {
    expect(helpers.applyDamage).toBe(applyDamage);
  });

  it('exposes the full spawner surface that call sites depend on', () => {
    const expected = [
      'applyDamage',
      'clearEntityStores',
      'createEntity',
      'setBloodColor',
      'DEFAULT_BLOOD_COLOR',
      'spawnPlayer',
      'spawnEnemy',
      'spawnBehaviorEnemy',
      'spawnSpawner',
      'spawnXpGem',
      'spawnGold',
      'spawnDroppedItem',
      'spawnProjectile',
      'spawnEnemyProjectile',
      'spawnAoeProjectile',
      'spawnReturningProjectile',
      'spawnBouncingProjectile',
      'spawnBeam',
      'spawnAreaAttack',
      'spawnMeleeSwing',
      'spawnTrap',
      'spawnNpc',
      'spawnProp',
      'spawnHarvestableNode',
    ] as const;
    for (const name of expected) {
      expect(helpers[name], `helpers.${name} should be exported`).toBeDefined();
    }
  });

  it('is callable through the facade (spawnPlayer smoke test)', () => {
    const world = createTestWorld();
    const eid = helpers.spawnPlayer(world, 1.5, 4.25);
    expect(hasComponent(world.ecs, eid, Player)).toBe(true);
    expect(world.stores.position.x[eid]).toBe(1.5);
  });
});
