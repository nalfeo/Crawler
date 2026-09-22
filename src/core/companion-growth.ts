import type { GameWorld } from './world.js';
import { companionGrowthScales } from '../shared/data/floor3/growth.js';
import { speciesForToken } from '../shared/data/floor3/species.js';

/** Rebase already-spawned stats once when progression crosses a form threshold. */
export function applyCompanionFormGrowth(
  world: GameWorld,
  eid: number,
  previousLevel: number,
): void {
  // Kept companions on later floors retain their existing contract.
  if (world.floorId !== 'floor3') return;
  const species = speciesForToken(world.stores.companion.speciesToken[eid] ?? 0);
  if (!species) return;
  const previous = companionGrowthScales(species, previousLevel);
  const next = companionGrowthScales(species, world.stores.companion.level[eid] ?? 1);
  if (previous.statScale === next.statScale) return;

  const health = world.stores.health;
  const previousMax = health.max[eid] ?? 0;
  const current = health.current[eid] ?? 0;
  const nextMax = Math.max(1, previousMax * (next.statScale / previous.statScale));
  health.max[eid] = nextMax;
  // Preserve injury fraction. Neither a same-tick death nor the KO sentinel
  // may be turned into a living combatant by a merit XP award.
  if (current > 0 && (world.stores.companion.knockedOut[eid] ?? 0) === 0) {
    health.current[eid] = Math.min(nextMax, current * (nextMax / Math.max(1, previousMax)));
  }
  const behavior = world.stores.enemyBehavior;
  behavior.speed[eid] = (behavior.speed[eid] ?? 0) * (next.speedScale / previous.speedScale);
  // Zero is the melee marker used by AI and combat; do not turn it into ranged AI.
  behavior.attackRange[eid] =
    (behavior.attackRange[eid] ?? 0) * (next.rangeScale / previous.rangeScale);
  world.stores.sprite.sizeScale[eid] =
    (world.stores.sprite.sizeScale[eid] || 1) * (next.visualScale / previous.visualScale);
}
