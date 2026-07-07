import { Worker, isMainThread, parentPort } from 'node:worker_threads';

if (isMainThread) {
  // Spawn a worker that uses node directly (not tsx) with the same --import flag
  const { Worker: W } = await import('node:worker_threads');
  const workerCode = `
    const { parentPort } = require('node:worker_threads');
    import('./src/game/ai/bt-ai-provider.js').then(m => {
      parentPort.postMessage('OK: ' + typeof m.BehaviorTreeAI);
    }).catch(e => {
      parentPort.postMessage('FAIL: ' + e.message.substring(0, 100));
    });
  `;
  const w = new Worker(workerCode, {
    eval: true,
    execArgv: [
      '--require', '/home/runner/work/Crawler/Crawler/node_modules/tsx/dist/preflight.cjs',
      '--import', 'file:///home/runner/work/Crawler/Crawler/node_modules/tsx/dist/loader.mjs'
    ],
  });
  w.on('message', (m: unknown) => console.log('Worker result:', m));
  w.on('error', (e: Error) => console.error('Worker error:', e.message.substring(0, 200)));
  w.on('exit', (c: number) => console.log('Exit:', c));
} else {
  parentPort?.postMessage('worker ts running');
}
