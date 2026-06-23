import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

const seeds = process.argv.slice(2).map(Number);
const BUDGET_MS = 5 * 60 * 1000;
const MAX_FRAMES = Math.ceil((BUDGET_MS * 1.1) / (1000 / 60));

let wins = 0;
for (const seed of seeds) {
  const ai = new BehaviorTreeAI({ seed });
  const stats = await runHeadless(ai, { seed, maxFrames: MAX_FRAMES });
  if (stats.outcome === 'victory') wins++;
  process.stdout.write(
    `${seed}\t${stats.outcome}\t${Math.round(stats.gameTimeMs / 1000)}s\tlv${stats.finalLevel}\t${stats.combat.totalKills}k\t${stats.quests.questsCompleted}q\tdmg${stats.combat.damageDealt}\n`,
  );
}
console.log(`\nWins: ${wins}/${seeds.length} = ${((wins / seeds.length) * 100).toFixed(0)}%`);
