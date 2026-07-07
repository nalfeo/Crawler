import { parentPort } from 'node:worker_threads';

// Use tsx's own register API
const { register } = await import('./node_modules/tsx/dist/esm/api/index.mjs');
register();

try {
  const mod = await import('./src/game/ai/bt-ai-provider.js');
  parentPort?.postMessage('OK: ' + typeof mod.BehaviorTreeAI);
} catch(e: unknown) {
  parentPort?.postMessage('FAIL: ' + (e as Error).message.substring(0, 150));
}
