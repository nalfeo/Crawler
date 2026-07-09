/**
 * Unit tests for the durable server-side override store
 * (`lib/overrides-store.mjs`). All fs touchpoints are injected so these run with
 * zero real disk IO. They verify: repo-keyed path resolution under
 * `$COPILOT_HOME`, read degrading to `{}` on missing/malformed files,
 * sanitize-on-read, and write doing mkdir + pretty JSON of the sanitized map.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import {
  resolveStorePath,
  readOverridesStore,
  writeOverridesStore,
} from '../lib/overrides-store.mjs';

test('resolveStorePath keys the file by repo root under $COPILOT_HOME', () => {
  const p1 = resolveStorePath('/repo/one', { env: { COPILOT_HOME: '/home/.copilot' } });
  const p2 = resolveStorePath('/repo/two', { env: { COPILOT_HOME: '/home/.copilot' } });

  assert.ok(p1.startsWith(path.join('/home/.copilot', 'extensions', 'achievements', 'artifacts')));
  assert.match(path.basename(p1), /^overrides\.[0-9a-f]{12}\.json$/);
  // Different repo roots ⇒ different files (sibling worktrees don't collide).
  assert.notEqual(p1, p2);
  // Deterministic for the same repo root.
  assert.equal(p1, resolveStorePath('/repo/one', { env: { COPILOT_HOME: '/home/.copilot' } }));
});

test('resolveStorePath falls back to ~/.copilot when COPILOT_HOME is unset', () => {
  const p = resolveStorePath('/repo/one', { env: {}, homedir: '/users/me' });
  assert.ok(p.startsWith(path.join('/users/me', '.copilot', 'extensions', 'achievements')));
});

test('resolveStorePath uses the os.homedir() default when the homedir dep is omitted', () => {
  // env:{} forces the ~/.copilot fallback (independent of ambient COPILOT_HOME);
  // omitting `homedir` exercises the `homedir ?? os.homedir()` default. This makes
  // the assertion deterministic and actually able to fail — not a tautology.
  const p = resolveStorePath('/repo/one', { env: {} });
  assert.ok(
    p.startsWith(path.join(os.homedir(), '.copilot', 'extensions', 'achievements', 'artifacts')),
  );
  assert.match(path.basename(p), /^overrides\.[0-9a-f]{12}\.json$/);
});

test('readOverridesStore returns {} when the file is missing', () => {
  const result = readOverridesStore('/nope.json', {
    readFile: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(result, {});
});

test('readOverridesStore returns {} for malformed JSON', () => {
  assert.deepEqual(readOverridesStore('/x.json', { readFile: () => 'not json {' }), {});
});

test('readOverridesStore sanitizes the parsed map', () => {
  const raw = JSON.stringify({
    good: { title: 'ok' },
    bad: 'string-not-object',
  });
  assert.deepEqual(readOverridesStore('/x.json', { readFile: () => raw }), {
    good: { title: 'ok' },
  });
});

test('writeOverridesStore mkdirs the parent and writes pretty, sanitized JSON', () => {
  const calls = { mkdir: [], write: [] };
  const written = writeOverridesStore(
    '/home/.copilot/extensions/achievements/artifacts/overrides.abc.json',
    { good: { title: 'ok' }, bad: 42 },
    {
      mkdir: (dir) => calls.mkdir.push(dir),
      writeFile: (p, data) => calls.write.push([p, data]),
    },
  );

  assert.deepEqual(calls.mkdir, ['/home/.copilot/extensions/achievements/artifacts']);
  assert.equal(calls.write.length, 1);
  const [writtenPath, writtenData] = calls.write[0];
  assert.equal(writtenPath, '/home/.copilot/extensions/achievements/artifacts/overrides.abc.json');
  // Sanitized (bad numeric entry dropped) + pretty-printed + trailing newline.
  assert.deepEqual(JSON.parse(writtenData), { good: { title: 'ok' } });
  assert.ok(writtenData.endsWith('\n'));
  assert.ok(writtenData.includes('\n  '), 'is indented (pretty-printed)');
  // Returns the sanitized map it persisted.
  assert.deepEqual(written, { good: { title: 'ok' } });
});

test('read/write round-trips through an in-memory fake fs', () => {
  const files = new Map();
  const filePath = resolveStorePath('/repo/one', { env: { COPILOT_HOME: '/h/.copilot' } });
  writeOverridesStore(
    filePath,
    { 'first-bonk': { title: 'Renamed', reward: { type: 'none' } } },
    { mkdir: () => {}, writeFile: (p, data) => files.set(p, data) },
  );
  const read = readOverridesStore(filePath, { readFile: (p) => files.get(p) });
  assert.deepEqual(read, { 'first-bonk': { title: 'Renamed', reward: { type: 'none' } } });
});
