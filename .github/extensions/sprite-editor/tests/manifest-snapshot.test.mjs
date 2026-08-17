/**
 * manifest-snapshot.test.mjs — covers the durable cross-process manifest cache.
 *
 * The snapshot is an ACCELERATOR, so the tests concentrate on the two properties
 * that make it safe rather than merely fast:
 *   1. it is never served when it could be stale (fingerprint/version gating);
 *   2. it never throws, on any malformed/missing/failing-IO path.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  SNAPSHOT_VERSION,
  readSnapshot,
  resolveSnapshotPath,
  writeSnapshot,
} from '../lib/manifest-snapshot.mjs';

const MANIFEST = { version: 1, entries: { 'a/b': { assetPath: 'generated/a.png' } } };

function snapshotJson(overrides = {}) {
  return JSON.stringify({
    snapshotVersion: SNAPSHOT_VERSION,
    fingerprint: '642:123',
    manifest: MANIFEST,
    ...overrides,
  });
}

test('resolveSnapshotPath keys the file by repo root under $COPILOT_HOME', () => {
  const one = resolveSnapshotPath('/repo/one', { env: { COPILOT_HOME: '/home/.copilot' } });
  const two = resolveSnapshotPath('/repo/two', { env: { COPILOT_HOME: '/home/.copilot' } });
  assert.notEqual(one, two, 'sibling worktrees must not share a snapshot file');
  assert.equal(one, resolveSnapshotPath('/repo/one', { env: { COPILOT_HOME: '/home/.copilot' } }));
  assert.match(
    one,
    /extensions[\\/]sprite-editor[\\/]artifacts[\\/]manifest\.[0-9a-f]{12}\.json$/u,
  );
});

test('resolveSnapshotPath falls back to ~/.copilot when COPILOT_HOME is unset', () => {
  const resolved = resolveSnapshotPath('/repo/one', { env: {}, homedir: '/home/u' });
  assert.equal(resolved, path.join('/home/u', '.copilot', ...resolved.split(path.sep).slice(-4)));
});

test('readSnapshot returns the manifest when the fingerprint matches', () => {
  const result = readSnapshot('/snap.json', '642:123', { readFile: () => snapshotJson() });
  assert.deepEqual(result, { manifest: MANIFEST });
});

test('readSnapshot rejects a stale fingerprint rather than serving it', () => {
  // This is the core correctness gate: shards changed, so the snapshot must be
  // ignored and the caller forced to recompose.
  assert.equal(readSnapshot('/snap.json', '643:999', { readFile: () => snapshotJson() }), null);
});

test('readSnapshot rejects a snapshot written by a different payload version', () => {
  const readFile = () => snapshotJson({ snapshotVersion: SNAPSHOT_VERSION + 1 });
  assert.equal(readSnapshot('/snap.json', '642:123', { readFile }), null);
});

test('readSnapshot degrades to null on missing, malformed, or shapeless files', () => {
  const cases = [
    () => {
      throw new Error('ENOENT');
    },
    () => 'not json{',
    () => 'null',
    () => JSON.stringify({ snapshotVersion: SNAPSHOT_VERSION, fingerprint: '642:123' }),
    () => snapshotJson({ manifest: { version: 1 } }),
    () => snapshotJson({ fingerprint: 42 }),
  ];
  for (const readFile of cases) {
    assert.equal(readSnapshot('/snap.json', '642:123', { readFile }), null);
  }
});

test('writeSnapshot persists atomically via a temp file then rename', () => {
  const writes = [];
  const renames = [];
  const removed = [];
  const ok = writeSnapshot('/dir/snap.json', '642:123', MANIFEST, {
    mkdir: () => {},
    writeFile: (p, data) => writes.push([p, data]),
    rename: (from, to) => renames.push([from, to]),
    remove: (p) => removed.push(p),
  });
  assert.equal(ok, true);
  assert.equal(writes.length, 1);
  assert.notEqual(writes[0][0], '/dir/snap.json', 'must write to a temp path, never in place');
  assert.deepEqual(renames, [[writes[0][0], '/dir/snap.json']]);
  assert.deepEqual(removed, [writes[0][0]], 'temp path is always cleaned up');
});

test('writeSnapshot round-trips through readSnapshot', () => {
  let stored = '';
  writeSnapshot('/dir/snap.json', '642:123', MANIFEST, {
    mkdir: () => {},
    writeFile: (_p, data) => {
      stored = data;
    },
    rename: () => {},
    remove: () => {},
  });
  assert.deepEqual(readSnapshot('/dir/snap.json', '642:123', { readFile: () => stored }), {
    manifest: MANIFEST,
  });
});

test('writeSnapshot returns false instead of throwing when IO fails', () => {
  // Failing to accelerate must never fail the request that triggered it.
  const ok = writeSnapshot('/dir/snap.json', '642:123', MANIFEST, {
    mkdir: () => {
      throw new Error('EACCES');
    },
    writeFile: () => {},
    rename: () => {},
    remove: () => {},
  });
  assert.equal(ok, false);
});

test('writeSnapshot uses a unique temp path per call', () => {
  const paths = [];
  const deps = {
    mkdir: () => {},
    writeFile: (p) => paths.push(p),
    rename: () => {},
    remove: () => {},
  };
  writeSnapshot('/dir/snap.json', '642:123', MANIFEST, deps);
  writeSnapshot('/dir/snap.json', '642:123', MANIFEST, deps);
  assert.notEqual(paths[0], paths[1], 'concurrent writers must not share a temp file');
});
