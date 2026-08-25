import { describe, expect, it } from 'vitest';
import { isSettlementReturnRoutingEnabled } from '../../src/game/ai/settlement-return-router.js';
import { syncAiRunnerSettlementReturnRouting } from '../../src/labs/ai-runner-lab/settlement-return-policy.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('AI runner settlement-return policy', () => {
  it('enables automated Floor 2 routing and resets it during manual takeover', () => {
    const world = createTestWorld({ seed: 42 });
    world.floorId = 'floor2';

    syncAiRunnerSettlementReturnRouting(world, true);
    expect(isSettlementReturnRoutingEnabled(world)).toBe(true);

    syncAiRunnerSettlementReturnRouting(world, false);
    expect(isSettlementReturnRoutingEnabled(world)).toBe(false);

    syncAiRunnerSettlementReturnRouting(world, true);
    expect(isSettlementReturnRoutingEnabled(world)).toBe(true);
  });

  it('leaves unsupported floors disabled', () => {
    const world = createTestWorld({ seed: 42 });
    world.floorId = 'floor3';

    syncAiRunnerSettlementReturnRouting(world, true);

    expect(isSettlementReturnRoutingEnabled(world)).toBe(false);
  });
});
