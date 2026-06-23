// Quick batch seed runner - run from project root
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const BUDGET_MS = 5 * 60 * 1000;
const MAX_FRAMES = Math.ceil((BUDGET_MS * 1.1) / (1000 / 60));

async function main() {
  let wins = 0;

  for (const seed of SEEDS) {
    const ai = new BehaviorTreeAI({ seed });
    const stats = await runHeadless(ai, { seed, maxFrames: MAX_FRAMES });
    const won = stats.outcome === 'victory';
    if (won) wins++;
    process.stdout.write(
      `Seed ${String(seed).padStart(2)}: ${stats.outcome.padEnd(8)} (${String(Math.round(stats.gameTimeMs / 1000)).padStart(3)}s, lv${stats.finalLevel}, ${stats.combat.totalKills}k)\n`,
    );
  }

  console.log(`\nWin rate: ${wins}/${SEEDS.length} = ${((wins / SEEDS.length) * 100).toFixed(0)}%`);
}

main().catch(console.error);
