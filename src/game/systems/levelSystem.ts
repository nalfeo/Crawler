import { addComponent, hasComponent, query } from 'bitecs';
import { Player, SkillHolder } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { xpRequiredForLevel } from '../../shared/xpMath.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';

/**
 * Accumulates XP into world.playerLevel and grants stat points on level-up.
 * Does NOT render UI — just increments unspentPoints. The level_up state is a
 * flag for the UI layer (MainGameScene's LevelUpUI) to pause and show the
 * stat-allocation screen. Labs/tests/headless use spendPoints() directly.
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
    world.state = 'level_up';

    // Add SkillHolder tag to player if not present
    const player = players[0];
    if (player !== undefined) {
      if (!hasComponent(world.ecs, player, SkillHolder)) {
        addComponent(world.ecs, player, SkillHolder);
      }

      // Queue a celebratory burst at the player (render-only; cosmetic).
      pushVfxEvent(world.vfxEvents, {
        kind: 'levelUpBurst',
        x: world.stores.position.x[player] ?? 0,
        y: world.stores.position.y[player] ?? 0,
      });
    }
  }
}
