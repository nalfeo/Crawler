import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
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

test('requires install only while local tsx is absent', () => {
  assert.equal(
    needsInstall('C:/repo', () => false),
    true,
  );
  assert.equal(
    needsInstall('C:/repo', (path) => path.endsWith('tsx.cmd')),
    false,
  );
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

test('marks dependencies as ready after a cold bootstrap so Bash skips duplicate npm ci', () => {
  const root = 'C:\\repo';
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const calls = [];
  const status = main({
    root,
    platform: 'win32',
    exists: (path) => path === bash,
    runCommand: (...args) => {
      calls.push(args);
      return 0;
    },
  });
  assert.equal(status, 0);
  assert.equal(calls[0][0], 'npm.cmd');
  assert.equal(calls[1][2].env.PREFLIGHT_DEPS_ALREADY_READY, '1');
});
