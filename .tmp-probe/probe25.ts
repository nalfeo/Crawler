import { BehaviorTreeAI } from '../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../src/game/ai/headless-runner.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../src/game/ai/floor1-run-budget.js';
import type { GameWorld } from '../src/core/world.js';
import type { InputState } from '../src/core/input.js';

class ProbeAI extends BehaviorTreeAI {
  override poll(state: InputState, world: GameWorld): void {
    super.poll(state, world);
    const f = world.frameCount;
    if (f >= 5900 && f <= 6420 && f % 10 === 0) {
      const d = this.getDecision();
      const px = world.stores.position.x[1];
      const py = world.stores.position.y[1];
      console.log(
        JSON.stringify({
          f,
          state: d.state,
          reason: d.reason,
          tx: d.targetX === null ? null : Math.round(d.targetX),
          ty: d.targetY === null ? null : Math.round(d.targetY),
          px: Math.round(px ?? 0),
          py: Math.round(py ?? 0),
          input: { x: Number(state.moveX.toFixed(2)), y: Number(state.moveY.toFixed(2)) },
          hp: world.stores.health.current[1],
        }),
      );
    }
  }
}

const stats = await runHeadless(new ProbeAI({ seed: 25 }), {
  seed: 25,
  maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
  maxWallTimeMs: 300_000,
  forceWeaponId: 'throwing-knife',
  enemyDamageMultiplier: 1,
});
console.log('outcome', stats.outcome, stats.totalFrames);
