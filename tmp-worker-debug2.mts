import { parentPort } from 'node:worker_threads';

try {
  const mod = await import('./src/game/ai/bt-ai-provider.js');
  parentPort?.postMessage('OK: ' + typeof mod.BehaviorTreeAI);
} catch(e: unknown) {
  parentPort?.postMessage('FAIL: ' + (e as Error).message.substring(0, 150));
}
