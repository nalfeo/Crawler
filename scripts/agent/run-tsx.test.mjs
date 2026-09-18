/* global URL */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  pinnedNodeCandidates,
  pinnedNodeVersion,
  npmCliForNode,
  resolvePinnedNode,
  runtimeEnvironment,
} from './run-tsx.mjs';

test('reads the repository-pinned Node version', () => {
  assert.equal(pinnedNodeVersion(), '22.23.2');
});

test('prefers the current executable when it already matches the pin', () => {
  const candidates = pinnedNodeCandidates({
    env: {},
    platform: 'win32',
    currentExecutable: 'C:\\current\\node.exe',
    currentVersion: '22.23.2',
  });
  assert.equal(candidates[0], 'C:\\current\\node.exe');
});

test('discovers the pinned fnm installation on Windows', () => {
  const expected =
    'C:\\Users\\agent\\AppData\\Roaming\\fnm\\node-versions\\v22.23.2\\installation\\node.exe';
  const resolved = resolvePinnedNode({
    env: { APPDATA: 'C:\\Users\\agent\\AppData\\Roaming' },
    platform: 'win32',
    currentExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    currentVersion: '24.0.0',
    exists: (candidate) => candidate === expected,
    versionFor: () => '22.23.2',
  });
  assert.equal(resolved, expected);
});

test('rejects an explicit runtime override with the wrong Node version', () => {
  const override = 'C:\\custom\\node.exe';
  const resolved = resolvePinnedNode({
    env: { CRAWLER_NODE_EXECUTABLE: override },
    platform: 'win32',
    currentExecutable: 'C:\\system\\node.exe',
    currentVersion: '24.0.0',
    exists: (candidate) => candidate === override,
    versionFor: () => '20.0.0',
  });
  assert.equal(resolved, null);
});

test('resolves npm beside the pinned Node executable', () => {
  assert.equal(
    npmCliForNode('C:\\pinned\\node.exe', 'win32'),
    'C:\\pinned\\node_modules\\npm\\bin\\npm-cli.js',
  );
  assert.equal(
    npmCliForNode('/opt/node/bin/node', 'linux'),
    '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
  );
});

test('runtime environment prepends pinned Node and preloads the identity shim', () => {
  const env = runtimeEnvironment(
    'C:\\pinned\\node.exe',
    { PATH: 'C:\\system', NODE_OPTIONS: '--trace-warnings' },
    'win32',
  );
  assert.equal(env.PATH, 'C:\\pinned;C:\\system');
  assert.match(env.NODE_OPTIONS, /^--trace-warnings --require=/);
  assert.match(env.NODE_OPTIONS, /windows-node-identity\.cjs/);
});

test('package scripts route tsx through the pinned runtime launcher', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const directTsxScripts = Object.entries(packageJson.scripts)
    .filter(([, command]) => /(?:^|[;&|]\s*)(?:npx\s+)?tsx\s/.test(command))
    .map(([name]) => name);

  assert.deepEqual(directTsxScripts, []);
});

test('checked-in agent shell entry points route tsx through the pinned runtime launcher', () => {
  const agentRoot = new URL('.', import.meta.url);
  const pending = [agentRoot];
  const violations = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const url = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        pending.push(new URL(`${entry.name}/`, directory));
      } else if (extname(entry.name) === '.sh') {
        const lines = readFileSync(url, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
          if (!line.trimStart().startsWith('#') && /(?:^|\s)(?:npx\s+)?tsx\s/.test(line)) {
            violations.push(`${join('scripts', 'agent', entry.name)}:${index + 1}`);
          }
        });
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('identity fallback is limited to the failing Windows user lookup', () => {
  const require = createRequire(import.meta.url);
  const { installWindowsIdentityFallback } = require('./windows-node-identity.cjs');
  const healthyTarget = {};
  installWindowsIdentityFallback({
    platform: 'win32',
    target: healthyTarget,
    lookup: () => ({ username: 'agent' }),
  });
  assert.equal(healthyTarget.geteuid, undefined);

  const restrictedTarget = {};
  installWindowsIdentityFallback({
    platform: 'win32',
    target: restrictedTarget,
    lookup: () => {
      const error = new Error('lookup failed');
      error.syscall = 'uv_os_get_passwd';
      throw error;
    },
  });
  assert.equal(restrictedTarget.geteuid(), 1000);
});
