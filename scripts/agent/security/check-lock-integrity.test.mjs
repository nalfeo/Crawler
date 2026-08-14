import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findChangedPackages,
  findFreshnessViolations,
  findLockfileDrift,
} from './check-lock-integrity.mjs';

test('requires package.json to accompany a lockfile change', () => {
  assert.equal(findLockfileDrift(['package-lock.json']), true);
  assert.equal(findLockfileDrift(['package.json', 'package-lock.json']), false);
  assert.equal(findLockfileDrift(['src/game/foo.ts']), false);
});

test('finds new and changed package resolutions but ignores the root entry', () => {
  const base = {
    packages: {
      '': { version: '1.0.0' },
      'node_modules/old': { version: '1.0.0', integrity: 'old' },
    },
  };
  const current = {
    packages: {
      '': { version: '1.0.0' },
      'node_modules/old': { version: '1.1.0', integrity: 'new' },
      'node_modules/@scope/new': { version: '2.0.0', integrity: 'new' },
    },
  };
  assert.deepEqual(findChangedPackages(base, current), [
    {
      name: 'old',
      version: '1.1.0',
      path: 'node_modules/old',
      resolved: undefined,
      integrity: 'new',
    },
    {
      name: '@scope/new',
      version: '2.0.0',
      path: 'node_modules/@scope/new',
      resolved: undefined,
      integrity: 'new',
    },
  ]);
});

test('rejects versions published inside the quarantine window', () => {
  const violations = findFreshnessViolations(
    [
      {
        name: 'new-pkg',
        version: '1.2.3',
        path: 'node_modules/new-pkg',
        resolved: 'https://registry.npmjs.org/new-pkg/-/new-pkg-1.2.3.tgz',
        integrity: 'sha512-test',
      },
    ],
    { 'new-pkg@1.2.3': '2026-08-10T00:00:00.000Z' },
    { now: new Date('2026-08-13T00:00:00.000Z') },
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'version is inside the registry proxy quarantine window');
});

test('accepts versions outside the quarantine window and fails closed on missing metadata', () => {
  const violations = findFreshnessViolations(
    [
      {
        name: 'old-pkg',
        version: '1.0.0',
        path: 'node_modules/old-pkg',
        resolved: 'https://registry.npmjs.org/old-pkg/-/old-pkg-1.0.0.tgz',
        integrity: 'sha512-test',
      },
      {
        name: 'unknown-pkg',
        version: '1.0.0',
        path: 'node_modules/unknown-pkg',
        resolved: 'https://registry.npmjs.org/unknown-pkg/-/unknown-pkg-1.0.0.tgz',
        integrity: 'sha512-test',
      },
    ],
    { 'old-pkg@1.0.0': '2026-08-01T00:00:00.000Z' },
    { now: new Date('2026-08-13T00:00:00.000Z') },
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, 'unknown-pkg');
});

test('rejects a lock entry whose tarball or integrity differs from registry metadata', () => {
  const violations = findFreshnessViolations(
    [
      {
        name: 'left-pad',
        version: '1.3.0',
        path: 'node_modules/left-pad',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: 'sha512-wrong',
      },
    ],
    {
      'left-pad@1.3.0': {
        publishedAt: '2020-01-01T00:00:00.000Z',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: 'sha512-canonical',
      },
    },
    { now: new Date('2026-08-13T00:00:00.000Z') },
  );
  assert.equal(
    violations[0].reason,
    'lockfile tarball or integrity does not match canonical registry metadata',
  );
});
