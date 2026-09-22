import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import process from 'node:process';
import {
  gitBashCandidates,
  main,
  needsInstall,
  npmCacheForWorktree,
  resolveBootstrapBash,
} from './preflight.mjs';

test('uses the standard Git for Windows location even when PATH omits bash', () => {
  const candidate = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(
    resolveBootstrapBash({}, 'win32', (path) => path === candidate),
    candidate,
  );
});

test('prefers an explicitly configured Git Bash location', () => {
  const candidate = 'D:\\Tools\\Git\\bin\\bash.exe';
  assert.equal(
    resolveBootstrapBash({ GIT_BASH: candidate }, 'win32', (path) => path === candidate),
    candidate,
  );
});

test('keeps ambient bash for non-Windows hosts', () => {
  assert.deepEqual(gitBashCandidates({}, 'linux'), ['bash']);
  assert.equal(
    resolveBootstrapBash({}, 'linux', () => false),
    'bash',
  );
});

test('requires install only while both local tsx entrypoints are absent', () => {
  assert.equal(
    needsInstall('C:/repo', () => false),
    true,
  );
  assert.equal(
    needsInstall('C:/repo', (path) => path.endsWith('tsx.cmd')),
    false,
  );
  assert.equal(
    needsInstall('C:/repo', (path) => path.replaceAll('\\', '/').endsWith('tsx/dist/cli.mjs')),
    false,
  );
});

test('uses the installed tsx entrypoint when a Windows command shim is absent', () => {
  const root = 'C:\\repo';
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const calls = [];
  const status = main({
    root,
    platform: 'win32',
    nodeExecutable: 'C:\\runtime\\node.exe',
    exists: (path) => path === bash || path.replaceAll('\\', '/').endsWith('tsx/dist/cli.mjs'),
    runCommand: (...args) => {
      calls.push(args);
      return 0;
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls[0][0], 'C:\\runtime\\node.exe');
  assert.deepEqual(calls[0][1][0], join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
});

test('keeps npm cache local to a worktree', () => {
  assert.equal(npmCacheForWorktree('C:/repo'), join('C:/repo', 'files', 'npm-cache'));
});

test('hands a warm Windows worktree to the existing Bash preflight through tsx', () => {
  const root = 'C:\\repo';
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const calls = [];
  const status = main({
    root,
    platform: 'win32',
    log: () => {},
    exists: (path) => path === bash || path.endsWith('tsx.cmd'),
    runCommand: (...args) => {
      calls.push(args);
      return 0;
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    [
      join(root, 'node_modules', '.bin', 'tsx.cmd'),
      ['scripts/agent/run-bash-wrapper.ts', 'scripts/agent/preflight.sh'],
      { cwd: root, env: { ...process.env, GIT_BASH: bash } },
    ],
  ]);
});

test('prints the resolved pinned runtime before starting a warm worktree', () => {
  const root = 'C:\\repo';
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const messages = [];
  const status = main({
    root,
    platform: 'win32',
    nodeExecutable: 'C:\\fnm\\v22.23.2\\node.exe',
    nodeVersion: '22.23.2',
    log: (message) => messages.push(message),
    exists: (path) => path === bash || path.endsWith('tsx.cmd'),
    runCommand: () => 0,
  });
  assert.equal(status, 0);
  assert.equal(messages[0], 'Agent runtime: Node 22.23.2 (C:\\fnm\\v22.23.2\\node.exe)');
});

test('marks dependencies as ready after a cold bootstrap so Bash skips duplicate npm ci', () => {
  const root = 'C:\\repo';
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const calls = [];
  let installed = false;
  const status = main({
    root,
    platform: 'win32',
    log: () => {},
    exists: (path) => path === bash || (installed && path.endsWith('tsx.cmd')),
    runCommand: (...args) => {
      calls.push(args);
      if (args[0] === 'npm.cmd') installed = true;
      return 0;
    },
  });
  assert.equal(status, 0);
  assert.equal(calls[0][0], 'npm.cmd');
  assert.equal(calls[1][2].env.PREFLIGHT_DEPS_ALREADY_READY, '1');
});

test('uses npm belonging to the selected runtime instead of Windows npm.cmd', () => {
  const root = 'C:\\repo';
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const calls = [];
  let installed = false;
  main({
    root,
    platform: 'win32',
    nodeExecutable: 'C:\\runtime\\node.exe',
    env: { CRAWLER_NPM_CLI: 'C:\\runtime\\node_modules\\npm\\bin\\npm-cli.js' },
    exists: (path) => path === bash || (installed && path.endsWith('tsx.cmd')),
    runCommand: (...args) => {
      calls.push(args);
      if (args[0] === 'C:\\runtime\\node.exe') installed = true;
      return 0;
    },
  });
  assert.deepEqual(calls, [
    [
      'C:\\runtime\\node.exe',
      ['C:\\runtime\\node_modules\\npm\\bin\\npm-cli.js', 'ci', '--prefer-offline'],
      {
        cwd: root,
        env: {
          CRAWLER_NPM_CLI: 'C:\\runtime\\node_modules\\npm\\bin\\npm-cli.js',
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
          npm_config_cache: join(root, 'files', 'npm-cache'),
        },
      },
    ],
    [
      'C:\\runtime\\node.exe',
      [
        join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        'scripts/agent/run-bash-wrapper.ts',
        'scripts/agent/preflight.sh',
      ],
      {
        cwd: root,
        env: {
          CRAWLER_NPM_CLI: 'C:\\runtime\\node_modules\\npm\\bin\\npm-cli.js',
          GIT_BASH: bash,
          PREFLIGHT_DEPS_ALREADY_READY: '1',
        },
      },
    ],
  ]);
});

test('stops with an actionable error if npm ci reports success without installing tsx', () => {
  const root = 'C:\\repo';
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  try {
    const status = main({
      root,
      platform: 'win32',
      log: () => {},
      exists: (path) => path === bash,
      runCommand: () => 0,
    });
    assert.equal(status, 1);
    assert.match(errors.join('\n'), /Another npm install may be running/);
  } finally {
    console.error = originalError;
  }
});
