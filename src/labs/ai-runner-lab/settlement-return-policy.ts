import type { GameWorld } from '../../core/world.js';
import {
  configureSettlementReturnRouting,
  isSettlementReturnRoutingEnabled,
} from '../../game/ai/settlement-return-router.js';

export function syncAiRunnerSettlementReturnRouting(
  world: GameWorld,
  isAutoDriven: boolean,
  featureFlagEnabled: boolean,
): void {
  const shouldEnable =
    featureFlagEnabled &&
    isAutoDriven &&
    (world.floorId === 'floor1' || world.floorId === 'floor2');
  if (isSettlementReturnRoutingEnabled(world) !== shouldEnable) {
    configureSettlementReturnRouting(world, shouldEnable);
  }
}
