import { BehaviorTreeAI } from './src/game/ai/bt-ai-provider.js';
import { runHeadless } from './src/game/ai/headless-runner.js';

const stats = await runHeadless(new BehaviorTreeAI({ seed: 4015 }), {
  seed: 4015,
  floorId: 'floor3',
  maxFrames: 1800,
  questStallFrames: 0,
  onFinish: (world) => {
    const counts = {};
    for (const e of world.combatEvents) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
    }
    console.log('event type counts', counts);
    const nonBlocked = world.combatEvents.filter((e) => e.type !== 'blocked');
    console.log('non-blocked events', nonBlocked.length);
    console.log(nonBlocked.slice(0, 20));
  },
});
console.log(JSON.stringify(stats.combat, null, 2));
