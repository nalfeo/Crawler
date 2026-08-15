import { BehaviorTreeAI } from '../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../src/game/ai/headless-runner.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../src/game/ai/floor1-run-budget.js';
import type { GameWorld } from '../src/core/world.js';
import type { InputState } from '../src/core/input.js';
import { query } from 'bitecs';
import { Enemy, Position, Health } from '../src/core/components.js';

class ProbeAI extends BehaviorTreeAI {
  override poll(state: InputState, world: GameWorld): void {
    super.poll(state, world);
    const f = world.frameCount;
    if (f === 6000 || f === 6200) {
      const px = world.stores.position.x[1] ?? 0;
      const py = world.stores.position.y[1] ?? 0;
      const map = world.floorMap;
      console.log('frame', f, 'player', px, py);
      if (map) {
        const t = map.worldToTile(px, py);
        console.log('tile', t);
        for (let dy = -3; dy <= 3; dy++) {
          let row = '';
          for (let dx = -3; dx <= 3; dx++) {
            row += map.tileMap.isPassable(t.x + dx, t.y + dy) ? '.' : '#';
          }
          console.log(row);
        }
      }
      const near: Array<[number, number, number]> = [];
      for (const eid of query(world.ecs, [Enemy, Position, Health])) {
        if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
        const ex = world.stores.position.x[eid] ?? 0;
        const ey = world.stores.position.y[eid] ?? 0;
        const d = Math.hypot(ex - px, ey - py);
        if (d < 12) near.push([Math.round(ex), Math.round(ey), Number(d.toFixed(1))]);
      }
      console.log('near enemies', JSON.stringify(near));
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
