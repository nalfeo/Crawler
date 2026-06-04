import { addComponent, hasComponent, query } from 'bitecs';
import { Player, Stats, SkillHolder } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { xpRequiredForLevel } from '../../shared/xpMath.js';

/**
 * Accumulates XP into world.playerLevel and grants stat points on level-up.
 * Does NOT render UI — just sets world.statsDirty and increments unspentPoints.
 * In v1 there is no pause: the level_up state is a flag for the UI layer to show
 * an allocation screen. Labs/tests use spendPoints() directly.
 */
export function levelSystem(world: GameWorld): void {
  const players = query(world.ecs, [Player]);
  if (players.length === 0) return;

  const pl = world.playerLevel;
  let currentLevel = pl.level;
  let leveled = false;

  // Advance levels as far as current XP allows
  while (xpRequiredForLevel(currentLevel + 1) <= pl.xp) {
    currentLevel++;
    pl.unspentPoints += pl.pointsPerLevel;
    leveled = true;
  }

  if (leveled) {
    pl.level = currentLevel;
    world.statsDirty = true;

    // Add Stats and SkillHolder tags to player if not present
    const player = players[0];
    if (player !== undefined) {
      if (!hasComponent(world.ecs, player, Stats)) {
        addComponent(world.ecs, player, Stats);
      }
      if (!hasComponent(world.ecs, player, SkillHolder)) {
        addComponent(world.ecs, player, SkillHolder);
      }
    }
  }
}
