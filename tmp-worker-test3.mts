import { parentPort } from 'node:worker_threads';

// Can we import tsx/esm/api in the worker?
try {
  const { register } = await import('tsx/esm/api');
  register();
  const mod = await import('./src/game/ai/bt-ai-provider.js');
  parentPort?.postMessage('OK: ' + typeof mod.BehaviorTreeAI);
} catch(e: unknown) {
  parentPort?.postMessage('FAIL: ' + (e as Error).message.substring(0, 150));
}
