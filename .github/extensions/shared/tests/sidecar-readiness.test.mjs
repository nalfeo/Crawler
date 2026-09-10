import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { EXPECTED_SIDECAR_VERSION, isSidecarReady } from '../sidecar-readiness.mjs';

test('extension readiness expects the server contract version', async () => {
  const contractSource = await readFile(
    new URL('../../../../scripts/sprites/sidecar/service-contract.ts', import.meta.url),
    'utf8',
  );
  const versionMatch = contractSource.match(
    /SPRITE_SIDECAR_SERVICE_VERSION\s*=\s*['"]([^'"]+)['"]/,
  );

  assert.ok(versionMatch, 'service-contract.ts must export SPRITE_SIDECAR_SERVICE_VERSION');
  assert.equal(EXPECTED_SIDECAR_VERSION, versionMatch[1]);
});

test('readiness requires a repository identity', () => {
  const healthy = { status: 'ok', version: EXPECTED_SIDECAR_VERSION, repoRoot: '/repo/a' };

  assert.equal(isSidecarReady(healthy), true);
  assert.equal(isSidecarReady({ ...healthy, repoRoot: undefined }), false);
  assert.equal(isSidecarReady({ ...healthy, repoRoot: '   ' }), false);
  assert.equal(isSidecarReady({ ...healthy, repoRoot: 42 }), false);
});
