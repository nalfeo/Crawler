import { parentPort } from 'node:worker_threads';

// Try to see if the ESM hooks are actually being hit by checking TSX_DEBUG
const debugInfo: string[] = [];

// Test direct import (not dynamic)
const result: string[] = [];

try {
  // Check if bt-ai-provider.ts exists
  const { existsSync } = await import('node:fs');
  result.push('ts exists: ' + existsSync('./src/game/ai/bt-ai-provider.ts'));
  result.push('js exists: ' + existsSync('./src/game/ai/bt-ai-provider.js'));
} catch(e: unknown) {
  result.push('fs check failed: ' + (e as Error).message.substring(0, 100));
}

try {
  // Try resolving .ts directly  
  const m1 = await import('./src/game/ai/bt-ai-provider.ts');
  result.push('OK .ts: ' + typeof m1.BehaviorTreeAI);
} catch(e: unknown) {
  result.push('FAIL .ts: ' + (e as Error).message.substring(0, 100));
}

try {
  const m2 = await import('./src/game/ai/bt-ai-provider.js');
  result.push('OK .js: ' + typeof m2.BehaviorTreeAI);
} catch(e: unknown) {
  result.push('FAIL .js: ' + (e as Error).message.substring(0, 100));
}

parentPort?.postMessage(result.join('\n'));
