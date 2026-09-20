import { entityExists, hasComponent, query } from 'bitecs';
import { describe, expect, it, vi } from 'vitest';
import {
  DeathTimer,
  DroppedItem,
  Enemy,
  EnemyBehavior,
  Gold,
  SiegeMinion,
  XpGem,
} from '../../src/core/components.js';
import {
  spawnAreaAttack,
  spawnBeam,
  spawnEnemy,
  spawnMeleeSwing,
  spawnPlayer,
  spawnProjectile,
  spawnTrap,
} from '../../src/core/helpers.js';
import { areaDamageSystem } from '../../src/core/systems/areaDamageSystem.js';
import { beamSystem } from '../../src/core/systems/beamSystem.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { healthSystem } from '../../src/core/systems/healthSystem.js';
import { meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import { trapSystem } from '../../src/core/systems/trapSystem.js';
import { isEnemyHostileToPlayer } from '../../src/core/enemy-targeting.js';
import { enemyAISystem } from '../../src/game/enemyAISystem.js';
import {
  initializeFloor5Scenario,
  siegeHeroSystem,
  siegeMinionSystem,
} from '../../src/game/floor5Scenario.js';
import { TeamId } from '../../src/shared/constants.js';
import floor5Manifest from '../../src/shared/data/floors/floor5.manifest.json' with { type: 'json' };
import { createTestWorld } from '../helpers/world-factory.js';

/** Real scenario spawns, with only time advanced to the first field Hero. */
function setup() {
  const world = createTestWorld({ seed: 505 });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor5Scenario(world, player);
  world.frameCount = floor5Manifest.floor5.heroes.firstSpawnFrame;
  world.elapsedMs = world.frameCount * (1000 / 60);
  siegeMinionSystem(world);
  siegeHeroSystem(world);
  const state = world.floorExtendedState!.floor5Siege!;
  const minions = Array.from(query(world.ecs, [SiegeMinion]));
  const ally = minions.find((eid) => world.stores.team.id[eid] === TeamId.SIEGE_ALLIED)!;
  const minion = minions.find((eid) => world.stores.team.id[eid] === TeamId.SIEGE_ENEMY)!;
  const hero = state.heroes.eid;
  expect(ally).toBeDefined();
  expect(minion).toBeDefined();
  expect(hero).toBeGreaterThan(0);
  return { world, player, ally, minion, hero, state };
}

describe('Floor 5 hostile combat adapter', () => {
  it('exposes only hostile actors to player targeting without stealing siege steering', () => {
    const { world, ally, minion, hero, state } = setup();
    for (const eid of [minion, hero]) {
      expect(isEnemyHostileToPlayer(world, eid)).toBe(true);
      expect(world.stores.team.id[eid]).toBe(TeamId.SIEGE_ENEMY);
      expect(hasComponent(world.ecs, eid, EnemyBehavior)).toBe(false);
    }
    expect(hasComponent(world.ecs, ally, Enemy)).toBe(false);
    expect(isEnemyHostileToPlayer(world, ally)).toBe(false);
    expect(world.stores.team.id[ally]).toBe(TeamId.SIEGE_ALLIED);
    for (const structure of Object.values(state.structures)) {
      expect(hasComponent(world.ecs, structure.eid, Enemy)).toBe(false);
    }
    const snapshot = () =>
      [ally, minion, hero].map((eid) => ({
        vx: world.stores.velocity.x[eid],
        vy: world.stores.velocity.y[eid],
        target:
          eid === hero
            ? world.stores.siegeHero.targetEid[eid]
            : world.stores.siegeMinion.targetEid[eid],
      }));
    const before = snapshot();
    enemyAISystem(world);
    expect(snapshot()).toEqual(before);
    for (const eid of [ally, minion]) {
      const target = world.stores.siegeMinion.targetEid[eid]!;
      expect(target).toBeGreaterThan(0);
      expect(world.stores.team.id[target]).not.toBe(world.stores.team.id[eid]);
    }
  });

  for (const attack of ['projectile', 'melee', 'area', 'beam', 'trap'] as const) {
    it(`${attack} damages hostile minions and Heroes while sparing allied units and structures`, () => {
      const { world, player, ally, minion, hero, state } = setup();
      const x = world.stores.position.x[player]!;
      const y = world.stores.position.y[player]!;
      const targets = [ally, minion, hero, ...Object.values(state.structures).map((s) => s.eid)];
      const before = targets.map((eid) => world.stores.health.current[eid]!);
      // Put every allegiance in the same hit volume: exclusion must come from
      // the production combat contract, never from distance or cover.
      for (const eid of targets) {
        world.stores.position.x[eid] = x + 2;
        world.stores.position.y[eid] = y;
      }
      if (attack === 'projectile') {
        spawnProjectile(world, x + 2, y, 0, 0, 5, 20, 0, 1, player);
        damageSystem(world, collisionSystem(world));
      } else if (attack === 'melee') {
        spawnMeleeSwing(world, x, y, player, 5, 4, 100, 1, 0, 90, TeamId.PLAYER);
        world.elapsedMs += 50;
        meleeSwingSystem(world, collisionSystem(world));
      } else if (attack === 'area') {
        spawnAreaAttack(world, x, y, player, 5, 4, 100, TeamId.PLAYER);
        areaDamageSystem(world, collisionSystem(world));
      } else if (attack === 'beam') {
        spawnBeam(world, x, y, 1, 0, 4, 5, 100, 0, player, TeamId.PLAYER);
        beamSystem(world, collisionSystem(world));
      } else {
        spawnTrap(world, x + 2, y, 5, 4, 4, 0, player, TeamId.PLAYER);
        trapSystem(world, collisionSystem(world));
        areaDamageSystem(world, collisionSystem(world));
      }
      targets.forEach((eid, index) => {
        if (eid === minion || eid === hero) {
          expect(world.stores.health.current[eid]).toBeLessThan(before[index]!);
        } else {
          expect(world.stores.health.current[eid]).toBe(before[index]);
        }
      });
    });
  }

  it('does not add generic player contact attacks or consume siege attack cooldowns', () => {
    const { world, player, minion, hero } = setup();
    const hp = world.stores.health.current[player];
    for (const eid of [minion, hero]) {
      world.stores.position.x[eid] = world.stores.position.x[player]!;
      world.stores.position.y[eid] = world.stores.position.y[player]!;
      const cooldown = world.stores.damage.lastFireMs[eid];
      damageSystem(world, collisionSystem(world));
      expect(world.stores.health.current[player]).toBe(hp);
      expect(world.stores.damage.lastFireMs[eid]).toBe(cooldown);
    }
    // The adapter must not disable ordinary enemy contact damage.
    spawnEnemy(world, world.stores.position.x[player]!, world.stores.position.y[player]!, 20);
    damageSystem(world, collisionSystem(world));
    expect(world.stores.health.current[player]).toBeLessThan(hp!);
  });

  it('retains immediate siege cleanup and Hero respawn without rewards or extra RNG draws', () => {
    const { world, minion, hero, state } = setup();
    const nextDraw = vi.spyOn(world.rng, 'next');
    world.stores.health.current[minion] = 0;
    world.stores.health.current[hero] = 0;
    dropSystem(world);
    expect(nextDraw).not.toHaveBeenCalled();
    for (const marker of [XpGem, Gold, DroppedItem]) {
      expect(Array.from(query(world.ecs, [marker]))).toHaveLength(0);
    }
    for (const eid of [minion, hero]) {
      expect(hasComponent(world.ecs, eid, DeathTimer)).toBe(false);
      expect(
        world.combatEvents.filter((e) => e.type === 'death' && e.targetEid === eid),
      ).toHaveLength(1);
    }
    healthSystem(world);
    world.floorObjectiveTick!(world);
    expect(entityExists(world.ecs, minion)).toBe(false);
    expect(entityExists(world.ecs, hero)).toBe(false);
    expect(world.mobAbilities.byEntity.has(hero)).toBe(false);
    expect(state.heroes).toMatchObject({
      status: 'down',
      eid: 0,
      defeats: 1,
      defeatedFrame: world.frameCount,
    });
    expect(state.heroes.respawnFrame).toBe(
      world.frameCount + floor5Manifest.floor5.heroes.respawnDelayFrames,
    );
    world.frameCount = state.heroes.respawnFrame!;
    siegeHeroSystem(world);
    expect(state.heroes.status).toBe('active');
    expect(isEnemyHostileToPlayer(world, state.heroes.eid)).toBe(true);
    expect(state.heroes.defeats).toBe(1);
  });
});
