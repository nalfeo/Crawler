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
      // Skip entities with DeathTimer — they're handled by deathTimerSystem
      if (hasComponent(world.ecs, eid, DeathTimer)) {
        continue;
      }

      // Dead entities must not retain status effects (including owned
      // mob-ability debuffs) after the death transition. Player death keeps the
      // entity around for game-over state, so clear the sidecar explicitly here.
      world.statusEffectsByEntity.delete(eid);

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
