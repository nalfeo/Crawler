import { afterEach, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getFloorManifest, resetBuiltInFloorManifests } from '../../src/shared/floor-registry.js';

afterEach(() => {
  resetBuiltInFloorManifests();
});

describe('runHeadless floor-registry contamination guard', () => {
  it('fails loudly when a built-in floor manifest mutation leaks across in-process runs', async () => {
    const floor1 = getFloorManifest('floor1');
    expect(floor1).toBeDefined();
    floor1!.timer.durationMs += 1;

    await expect(
      runHeadless(new BehaviorTreeAI({ seed: 1 }), {
        seed: 1,
        maxFrames: 1,
      }),
    ).rejects.toThrow(
      /resetBuiltInFloorManifests\(\).*fresh Node process|fresh Node process.*resetBuiltInFloorManifests\(\)/,
    );
  });
});
