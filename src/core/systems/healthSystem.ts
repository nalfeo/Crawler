import { hasComponent, query, removeEntity } from 'bitecs';
import { DeathTimer, Enemy, Health, Player } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('core:health-system');

export function healthSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Health]);
  const { health } = world.stores;

  for (const eid of Array.from(entities)) {
    if (eid === undefined) {
      continue;
    }

    const currentHealth = health.current[eid] ?? 0;

    if (currentHealth <= 0) {
      // Clear status-effect sidecar for every dead entity so that Tarnished
      // indicators and other debuffs don't persist through the corpse linger.
      // This must run before the DeathTimer early-return so entities with a
      // linger timer are also cleaned up.
      world.statusEffectsByEntity.delete(eid);

      // Skip entities with DeathTimer — they're handled by deathTimerSystem
      if (hasComponent(world.ecs, eid, DeathTimer)) {
        continue;
      }

      if (hasComponent(world.ecs, eid, Player)) {
        world.state = 'game_over';
        logger.warn('Player health reached zero; transitioning to game_over', {
          eid,
          frameCount: world.frameCount,
          elapsedMs: world.elapsedMs,
        });
      } else {
        // Drops are handled by dropSystem which runs before healthSystem.
        // We only handle entity cleanup here.
        if (hasComponent(world.ecs, eid, Enemy)) {
          // no-op: drops already spawned by dropSystem
        }

        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
        logger.debug('Removed dead entity', { eid, frameCount: world.frameCount });
      }
    }
  }
}
