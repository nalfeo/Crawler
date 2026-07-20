import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginSpriteSidecarStartup, ensureSpriteSidecar } from '../sprite-sidecar-service.mjs';

test('ensureSpriteSidecar invokes the repo manager and parses its final JSON line', async () => {
  let invocation = null;
  const result = await ensureSpriteSidecar(process.cwd(), {
    execFile: async (command, args, options) => {
      invocation = { command, args, options };
      return {
        stdout:
          'Azure environment already configured\n{"ok":true,"state":"started","pid":42,"logPath":"service.log"}\n',
      };
    },
  });

  assert.equal(invocation.command, 'node');
  assert.ok(invocation.args.includes('ensure'));
  assert.ok(invocation.args.includes('--repo-root'));
  assert.equal(invocation.options.timeout, 100_000);
  assert.equal(result.state, 'started');
  assert.equal(result.pid, 42);
});

test('ensureSpriteSidecar skips local startup for an explicit sidecar override', async () => {
  let invoked = false;
  const result = await ensureSpriteSidecar(process.cwd(), {
    env: { VITE_SPRITES_SIDECAR_BASE_URL: 'http://override:4999/' },
    execFile: async () => {
      invoked = true;
      throw new Error('should not run');
    },
  });

  assert.equal(invoked, false);
  assert.equal(result.state, 'reused');
  assert.equal(result.baseUrl, 'http://override:4999');
});

test('beginSpriteSidecarStartup publishes ready state after automatic startup', async () => {
  const states = [];
  const entry = {
    workspaceRoot: process.cwd(),
    sidecarStartup: null,
    pushState: async () => {
      states.push(entry.sidecarStartup);
    },
  };

  beginSpriteSidecarStartup(entry, {
    execFile: async () => ({
      stdout: '{"ok":true,"state":"reused","pid":7,"logPath":"managed.log"}\n',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(entry.sidecarStartup.state, 'ready');
  assert.equal(entry.sidecarStartup.logPath, 'managed.log');
  assert.equal(states.at(-1).state, 'ready');
});

test('beginSpriteSidecarStartup publishes actionable failures', async () => {
  const entry = {
    workspaceRoot: process.cwd(),
    sidecarStartup: null,
    pushState: async () => {},
  };
  beginSpriteSidecarStartup(entry, {
    execFile: async () => {
      throw new Error('Azure credentials unavailable');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(entry.sidecarStartup, {
    state: 'error',
    error: 'Azure credentials unavailable',
    logPath: null,
  });
});
