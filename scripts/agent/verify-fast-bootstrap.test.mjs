import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { main } from './verify-fast.mjs';

function fixture({ ready = false, installStatus = 0, verifyStatus = 0, installsTsx = true } = {}) {
  const calls = [];
  const root = '/worktree';
  const nodeExecutable = '/pinned/node';
  const env = { CRAWLER_NPM_CLI: '/pinned/npm-cli.js', PATH: '/pinned' };
  const status = main({
    root,
    nodeExecutable,
    env,
    exists: (file) => ready && file === join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    log: () => {},
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === env.CRAWLER_NPM_CLI) {
        ready = installStatus === 0 && installsTsx;
        return { status: installStatus };
      }
      assert.ok(ready, 'verification cannot run before tsx exists');
      return { status: verifyStatus };
    },
  });
  return { calls, status, root, nodeExecutable, env };
}

test('npm verify:fast enters the dependency-free bootstrap using pinned Node', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(
    pkg.scripts['verify:fast'],
    'node scripts/agent/run-tsx.mjs --node scripts/agent/verify-fast.mjs',
  );
});

test('a fresh stage installs before invoking the unchanged verifier in its own worktree', () => {
  const { calls, status, root, nodeExecutable, env } = fixture();
  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    command: nodeExecutable,
    args: [env.CRAWLER_NPM_CLI, 'ci', '--ignore-scripts', '--prefer-offline'],
    options: { cwd: root, env, stdio: 'inherit' },
  });
  assert.deepEqual(calls[1], {
    command: nodeExecutable,
    args: [
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'scripts/agent/run-bash-wrapper.ts',
      'scripts/agent/verify-fast.sh',
    ],
    options: { cwd: root, env, stdio: 'inherit' },
  });
});

test('warm worktrees avoid reinstalling dependencies', () => {
  const { calls, status } = fixture({ ready: true });
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
});

test('failed installation stops before verification and preserves its exit code', () => {
  const { calls, status } = fixture({ installStatus: 17 });
  assert.equal(status, 17);
  assert.equal(calls.length, 1);
});

test('an interrupted installation fails closed', () => {
  assert.equal(fixture({ installStatus: null }).status, 1);
});

test('a successful installer that leaves tsx missing cannot pass verification', () => {
  assert.throws(() => fixture({ installsTsx: false }), /did not provide tsx/);
});

test('verification failure is preserved after bootstrap and on warm worktrees', () => {
  assert.equal(fixture({ verifyStatus: 23 }).status, 23);
  assert.equal(fixture({ ready: true, verifyStatus: 23 }).status, 23);
});

test('spawn failures cannot report success', () => {
  assert.throws(
    () => main({ exists: () => true, spawn: () => ({ error: new Error('spawn failed') }) }),
    /spawn failed/,
  );
});
