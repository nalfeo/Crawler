import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnexpectedErrorHandler } from './unexpected-error.mjs';

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('unexpected errors release ownership once and preserve the original error', async () => {
  const errors = [];
  let cleanupCalls = 0;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const handle = createUnexpectedErrorHandler({
    cleanup: async () => {
      cleanupCalls += 1;
    },
    writeError: (message) => errors.push(message),
  });

  handle(new Error('root failure'));
  handle(new Error('secondary failure'));
  await flush();

  assert.equal(cleanupCalls, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /root failure/);
  assert.doesNotMatch(errors[0], /secondary failure/);
  process.exitCode = originalExitCode;
});

test('cleanup failures are reported without replacing the original error', async () => {
  const errors = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const handle = createUnexpectedErrorHandler({
    cleanup: async () => {
      throw new Error('release failed');
    },
    writeError: (message) => errors.push(message),
  });

  handle(new Error('root failure'));
  await flush();

  assert.equal(errors.length, 2);
  assert.match(errors[0], /release failed/);
  assert.match(errors[1], /root failure/);
  process.exitCode = originalExitCode;
});
