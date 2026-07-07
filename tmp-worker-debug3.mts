import { parentPort } from 'node:worker_threads';

// Just try to resolve the file URL
try {
  const url = import.meta.resolve('./src/game/ai/bt-ai-provider.js');
  parentPort?.postMessage('resolved to: ' + url);
} catch(e: unknown) {
  parentPort?.postMessage('resolve FAIL: ' + (e as Error).message.substring(0, 150));
}
