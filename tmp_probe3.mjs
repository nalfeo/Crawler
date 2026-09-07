import { BehaviorTreeAI } from './src/game/ai/bt-ai-provider.js';
import { runHeadless } from './src/game/ai/headless-runner.js';

const stats = await runHeadless(new BehaviorTreeAI({ seed: 4015 }), {
  seed: 4015,
  floorId: 'floor3',
  maxFrames: 1800,
  questStallFrames: 0,
  onFinish: (world) => {
    console.log('playerLevel', world.playerLevel?.level, world.playerLevel?.unspentPoints);
    console.log('companion count', world.combatEvents.length);
    console.log('combatEvents sample', world.combatEvents.slice(0, 10));
  },
});
console.log(JSON.stringify(stats.combat, null, 2));
