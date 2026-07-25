import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSerializedThemeEquipmentReviewRunner, loadRepoEnv } from '../lib/bridge.mjs';

test('loads missing values from .env.local without overriding the process environment', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'theme-review-env-'));
  try {
    writeFileSync(
      path.join(root, '.env.local'),
      'SPRITES_RUN_STORE=azure-blob\nAZURE_STORAGE_ACCOUNT="from-file"\n',
    );
    const env = loadRepoEnv(root, { AZURE_STORAGE_ACCOUNT: 'already-set' });
    assert.equal(env.SPRITES_RUN_STORE, 'azure-blob');
    assert.equal(env.AZURE_STORAGE_ACCOUNT, 'already-set');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serializes state mutations per set while allowing different sets to proceed', async () => {
  const started = [];
  let releaseFirst;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const run = createSerializedThemeEquipmentReviewRunner(async (command) => {
    started.push(`${command.setId}:${command.expectedRevision}`);
    if (command.setId === 'classic-fantasy' && command.expectedRevision === 0) await first;
    return command.expectedRevision;
  });

  const firstMutation = run({
    action: 'item-review',
    setId: 'classic-fantasy',
    expectedRevision: 0,
  });
  const secondMutation = run({
    action: 'set-review',
    setId: 'classic-fantasy',
    expectedRevision: 1,
  });
  const otherSetMutation = run({
    action: 'advance',
    setId: 'pirate',
    expectedRevision: 4,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(started, ['classic-fantasy:0', 'pirate:4']);
  releaseFirst();
  assert.deepEqual(await Promise.all([firstMutation, secondMutation, otherSetMutation]), [0, 1, 4]);
  assert.deepEqual(started, ['classic-fantasy:0', 'pirate:4', 'classic-fantasy:1']);
});
