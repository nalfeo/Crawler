#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const skipNpm = process.argv.includes('--skip-npm');
const nodeVersion = readFileSync(new URL('../../.node-version', import.meta.url), 'utf8').trim();
const pythonVersion = readFileSync(
  new URL('../../.python-version', import.meta.url),
  'utf8',
).trim();
const requirements = 'scripts/sprites/proper-pixel-art-requirements.txt';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: new URL('../..', import.meta.url),
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw new Error(`Unable to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.versions.node !== nodeVersion) {
  throw new Error(
    `Crawler requires Node ${nodeVersion} (from .node-version); found ${process.versions.node}.`,
  );
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const python = process.platform === 'win32' ? 'py.exe' : 'python';
const pythonSelector = process.platform === 'win32' ? ['-3.12'] : [];
const versionProbe = spawnSync(python, [...pythonSelector, '--version'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const actualPython = `${versionProbe.stdout ?? ''}${versionProbe.stderr ?? ''}`.trim();
if (versionProbe.status !== 0 || !actualPython.includes(pythonVersion)) {
  throw new Error(
    `Crawler requires Python ${pythonVersion} (from .python-version); found ${actualPython || 'no usable Python'}.`,
  );
}

if (!skipNpm) {
  run(npm, ['ci'], {
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });
}

run(python, [
  ...pythonSelector,
  '-m',
  'pip',
  'install',
  '--no-deps',
  '--only-binary=:all:',
  '--requirement',
  requirements,
]);
run(python, [...pythonSelector, '-m', 'pip', 'check']);

console.log(
  `Crawler environment ready: Node ${nodeVersion}, Python ${pythonVersion}, dependencies synchronized.`,
);
