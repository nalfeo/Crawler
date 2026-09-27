import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from './verify-fast.mjs';

const verification = ['scripts/agent/run-bash-wrapper.ts', 'scripts/agent/verify-fast.sh'];

test('fresh worktree installs before running the unchanged fast gate', async () => {
  let installed = false;
  const calls = [];
  const status = await main({
    exists: () => installed,
    run: async (args) => {
      calls.push(args);
      installed = true;
      return 0;
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [['--npm', 'ci', '--ignore-scripts', '--prefer-offline'], verification]);
});

test('warm worktree skips installation and preserves verification failure', async () => {
  const calls = [];
  assert.equal(
    await main({
      exists: () => true,
      run: async (args) => {
        calls.push(args);
        return 23;
      },
    }),
    23,
  );
  assert.deepEqual(calls, [verification]);
});

test('installation failure stops verification and preserves the exit status', async () => {
  const calls = [];
  assert.equal(
    await main({
      exists: () => false,
      run: async (args) => {
        calls.push(args);
        return 17;
      },
    }),
    17,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '--npm');
});

test('missing payload after successful installation cannot pass the gate', async () => {
  let calls = 0;
  await assert.rejects(
    main({
      exists: () => false,
      run: async () => {
        calls++;
        return 0;
      },
    }),
    /bootstrap completed without tsx/,
  );
  assert.equal(calls, 1);
});

test('process launch failures propagate', async () => {
  await assert.rejects(
    main({
      exists: () => false,
      run: async () => {
        throw new Error('cannot spawn npm');
      },
    }),
    /cannot spawn npm/,
  );
});
