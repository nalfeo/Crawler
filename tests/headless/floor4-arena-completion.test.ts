import { describe, expect, it } from 'vitest';
import type { GameWorld } from '../../src/core/world.js';
import { GAME } from '../../src/shared/constants.js';
import type { InputState } from '../../src/shared/input.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';

class IdleFloor4Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor4 empty-arena rehearsal',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

describe('Floor 4 empty-arena headless timeline', () => {
  it('reaches victory and records a deterministic phase timeline', async () => {
    const run = () =>
      runHeadless(new IdleFloor4Provider(), {
        floorId: 'floor4',
        seed: 404,
        maxFrames: Math.ceil(610_000 / GAME.DELTA_MS),
        questStallFrames: 1_000_000,
      });

    const first = await run();
    const second = await run();

    expect(first.outcome).toBe('victory');
    expect(first.floor4Arena?.phase).toEqual({ kind: 'VICTORY' });
    expect(first.floor4Arena?.arenaElapsedMs).toBe(600_000);
    expect(first.floor4Arena?.timeline).toEqual(second.floor4Arena?.timeline);
  });
});
