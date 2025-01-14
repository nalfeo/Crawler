import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';

describe('runHeadless enemyTelegraphMs validation', () => {
  it('rejects a finite value too large for the Float32 telegraphDelayMs store (regression: copilot-pull-request-reviewer finding)', async () => {
    // `world.enemyTelegraphMs` feeds `EnemyBehavior.telegraphDelayMs`, a
    // Float32Array (components.ts). A finite JS number outside Float32's
    // representable range silently rounds to Infinity on assignment, and
    // isEnemyProjectileTelegraphReady's `elapsed >= delayMs` fire check can
    // then never trip -- the enemy telegraphs forever and never fires. This
    // must be rejected at config-validation time, before the sim ever runs.
    await expect(
      runHeadless(new BehaviorTreeAI({ seed: 1 }), {
        seed: 1,
        enemyTelegraphMs: 1e39,
        maxFrames: 1,
      }),
    ).rejects.toThrow(/enemyTelegraphMs/);
  });

  it('rejects Infinity outright (already finite-checked, kept for clarity)', async () => {
    await expect(
      runHeadless(new BehaviorTreeAI({ seed: 1 }), {
        seed: 1,
        enemyTelegraphMs: Number.POSITIVE_INFINITY,
        maxFrames: 1,
      }),
    ).rejects.toThrow(/enemyTelegraphMs/);
  });

  it('rejects a tiny nonzero value that would underflow to 0 in the Float32 telegraphDelayMs store (regression: copilot-pull-request-reviewer finding)', async () => {
    // `Math.fround(1e-50) === 0`: a delay this small survives the finite and
    // overflow checks unchanged, but once written to the Float32Array store
    // it becomes byte-identical to an intentional, legitimate "legacy: no
    // telegraph" `0` override -- silently degrading a configured nonzero
    // delay into immediate-fire/no-telegraph behavior. Must be rejected at
    // config-validation time, same as overflow.
    await expect(
      runHeadless(new BehaviorTreeAI({ seed: 1 }), {
        seed: 1,
        enemyTelegraphMs: 1e-50,
        maxFrames: 1,
      }),
    ).rejects.toThrow(/enemyTelegraphMs/);
  });

  it('accepts an explicit 0 (legitimate legacy parity, distinct from underflow)', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 1 }), {
      seed: 1,
      enemyTelegraphMs: 0,
      maxFrames: 1,
    });
    expect(stats).toBeDefined();
  });

  it('accepts a normal, well within range telegraph delay', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 1 }), {
      seed: 1,
      enemyTelegraphMs: 250,
      maxFrames: 1,
    });
    expect(stats).toBeDefined();
  });
});
