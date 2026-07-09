/**
 * Unit tests for the best-effort registry/catalog id loader. It transpiles two TS
 * data modules via esbuild; ANY failure must degrade to
 * `{ spriteIds:null, itemIds:null, error }` (never throw), so the backlog's
 * integration column shows an honest "unverified" state instead of fabricating
 * parity. We test the real repo (happy path) + a bogus root (degrade path).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistryIds } from '../lib/registry-ids.mjs';

// Four hops from tests/ -> workflow/ -> extensions/ -> .github/ -> repo root.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

test('loadRegistryIds resolves real sprite + item ids from the repo TS sources', async () => {
  const result = await loadRegistryIds(REPO_ROOT);
  assert.equal(result.error, null, `expected no error, got: ${result.error}`);
  assert.ok(result.spriteIds instanceof Set && result.spriteIds.size > 0, 'sprite ids loaded');
  assert.ok(result.itemIds instanceof Set && result.itemIds.size > 0, 'item ids loaded');
  // ids are non-empty strings
  for (const id of result.spriteIds) {
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  }
});

test('loadRegistryIds degrades honestly (never throws) for a bogus repo root', async () => {
  const result = await loadRegistryIds(path.join(REPO_ROOT, 'no', 'such', 'dir'));
  assert.equal(result.spriteIds, null);
  assert.equal(result.itemIds, null);
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error message present');
});
