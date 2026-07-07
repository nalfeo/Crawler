import { parentPort } from 'node:worker_threads';

const result: string[] = [];

// Try resolving core/index.js from bt-ai-provider context
try {
  // Simulate what bt-ai-provider.ts would import 
  const url = import.meta.resolve('../../core/index.js');
  result.push('resolve core/index.js: ' + url);
} catch(e: unknown) {
  result.push('resolve FAIL: ' + (e as Error).message.substring(0, 100));
}

try {
  const url2 = import.meta.resolve('./src/game/ai/bt-ai-provider.js');
  result.push('resolve bt-ai-provider.js: ' + url2);
} catch(e: unknown) {
  result.push('resolve2 FAIL: ' + (e as Error).message.substring(0, 100));
}

parentPort?.postMessage(result.join('\n'));
