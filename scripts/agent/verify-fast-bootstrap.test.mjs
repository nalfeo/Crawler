import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { main } from './verify-fast.mjs';

for (const platform of ['linux', 'win32']) {
  test(`fresh ${platform} gate installs before running all verifier phases`, () => {
    const root = 'fixture';
    const nodeExecutable = 'pinned-node';
    const npmCli = 'pinned-npm-cli.js';
    const bash = platform === 'win32' ? 'git-bash.exe' : 'bash';
    const calls = [];
    let installed = false;
    const status = main({
      root,
      platform,
      nodeExecutable,
      env: { CRAWLER_NPM_CLI: npmCli, GIT_BASH: bash },
      log: () => {},
      exists: (path) =>
        path === bash ||
        (installed && path === join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')),
      runCommand: (command, args, options) => {
        calls.push({ command, args, options });
        installed = true;
        return 0;
      },
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, nodeExecutable);
    assert.deepEqual(calls[0].args, [npmCli, 'ci', '--prefer-offline']);
    assert.equal(calls[0].options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
    assert.equal(calls[0].options.env.npm_config_cache, join(root, 'files', 'npm-cache'));
    assert.equal(calls[1].command, nodeExecutable);
    assert.deepEqual(calls[1].args, [
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'scripts/agent/run-bash-wrapper.ts',
      'scripts/agent/verify-fast.sh',
    ]);
    assert.equal(calls[1].options.cwd, root);
    assert.equal(calls[1].options.env.GIT_BASH, bash);
  });
}

test('warm gate skips install and propagates verifier failure', () => {
  const calls = [];
  const status = main({
    root: 'fixture',
    platform: 'linux',
    env: {},
    log: () => {},
    exists: () => true,
    runCommand: (...args) => {
      calls.push(args);
      return 17;
    },
  });
  assert.equal(status, 17);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [
    'scripts/agent/run-bash-wrapper.ts',
    'scripts/agent/verify-fast.sh',
  ]);
});

test('failed install stops verification and preserves failure status', () => {
  const calls = [];
  const status = main({
    root: 'fixture',
    platform: 'linux',
    env: {},
    log: () => {},
    exists: () => false,
    runCommand: (...args) => {
      calls.push(args);
      return 23;
    },
  });
  assert.equal(status, 23);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['ci', '--prefer-offline']);
});
