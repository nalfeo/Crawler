// Probe a single seed with detailed output
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

const seed = parseInt(process.argv[2] ?? '2', 10);
const BUDGET_MS = 5 * 60 * 1000;
const MAX_FRAMES = Math.ceil((BUDGET_MS * 1.1) / (1000 / 60));

const ai = new BehaviorTreeAI({ seed });
const stats = await runHeadless(ai, { seed, maxFrames: MAX_FRAMES, debug: true });
console.log(JSON.stringify(stats, null, 2));
