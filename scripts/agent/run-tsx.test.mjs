import assert from 'node:assert/strict';
import test from 'node:test';
import process from 'node:process';

import { createRequire } from 'node:module';

import { nodeArchive, pinnedNodeCandidates, runtimeEnvironment } from './run-tsx.mjs';

test('selects a managed runtime before any ambient Node executable', () => {
  const candidates = pinnedNodeCandidates({
    root: process.cwd(),
    env: { CRAWLER_RUNTIME_CACHE: 'C:\\runtime-cache' },
    platform: 'win32',
    arch: 'x64',
    currentExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    currentVersion: '24.19.0',
  });
  assert.equal(candidates[0], 'C:\\runtime-cache\\node-v22.23.2-win-x64\\node.exe');
});

test('uses an official archive name for each supported host family', () => {
  assert.deepEqual(nodeArchive({ version: '22.23.2', platform: 'win32', arch: 'x64' }), {
    target: 'win-x64',
    filename: 'node-v22.23.2-win-x64.zip',
  });
  assert.deepEqual(nodeArchive({ version: '22.23.2', platform: 'linux', arch: 'arm64' }), {
    target: 'linux-arm64',
    filename: 'node-v22.23.2-linux-arm64.tar.gz',
  });
});

test('passes the selected Node and its npm CLI to child processes', () => {
  const env = runtimeEnvironment('C:\\runtime-cache\\node.exe', { Path: 'C:\\system' }, 'win32');
  assert.equal(env.CRAWLER_NODE_EXECUTABLE, 'C:\\runtime-cache\\node.exe');
  assert.equal(env.CRAWLER_NPM_CLI, 'C:\\runtime-cache\\node_modules\\npm\\bin\\npm-cli.js');
  assert.equal(env.PATH, 'C:\\runtime-cache;C:\\system');
  assert.equal(env.Path, undefined);
  assert.match(env.NODE_OPTIONS, /windows-node-identity\.cjs/);
});

test('uses the identity fallback only for the known restricted Windows lookup', () => {
  const require = createRequire(import.meta.url);
  const { installWindowsIdentityFallback } = require('./windows-node-identity.cjs');
  const healthy = {};
  installWindowsIdentityFallback({
    platform: 'win32',
    target: healthy,
    lookup: () => ({ username: 'agent' }),
  });
  assert.equal(healthy.geteuid, undefined);
  const restricted = {};
  installWindowsIdentityFallback({
    platform: 'win32',
    target: restricted,
    lookup: () => {
      throw Object.assign(new Error('lookup failed'), { syscall: 'uv_os_get_passwd' });
    },
  });
  assert.equal(restricted.geteuid(), 1000);
});
