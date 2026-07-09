/**
 * Unit tests for the DESTRUCTIVE-op decision (`lib/mutation-guard.mjs`). This is
 * the safety-critical logic standing between the iframe and an IRREVERSIBLE Azure
 * archive/delete: token → validate-keys → health-gate → execute, in that order.
 *
 * `extension.mjs` can't be imported (top-level `await joinSession`), so before this
 * module was extracted the ordering + refusals were entirely uncovered — a one-line
 * deletion of the health gate would have shipped green. Every I/O dependency is
 * injected as a spy, so these assert the ordering deterministically and NEVER touch
 * a real blob (project rule #10 + the Slice E destructive-ops brief).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mutationTokenError,
  mutationKeysError,
  sidecarHealthError,
  bodyErrorResult,
  decideMutation,
} from '../lib/mutation-guard.mjs';

const TOKEN = 'instance-secret-token';

/** decideMutation deps whose spies record whether each downstream stage ran. */
function makeDeps(overrides = {}) {
  const { healthState = 'up', ...rest } = overrides;
  const calls = { readBody: 0, probeHealth: 0, execute: 0, executeKeys: null };
  const deps = {
    token: TOKEN,
    expectedToken: TOKEN,
    allowArchive: false,
    verb: 'archive',
    readBody: async () => {
      calls.readBody += 1;
      return { keys: ['brief-a/run-1'] };
    },
    probeHealth: async () => {
      calls.probeHealth += 1;
      return { state: healthState };
    },
    execute: async (keys) => {
      calls.execute += 1;
      calls.executeKeys = keys;
      return { ok: true, archived: keys, skipped: [] };
    },
    ...rest,
  };
  return { deps, calls };
}

// ── Gate 1: mutation token ──────────────────────────────────────────────────

test('mutationTokenError: missing / empty / wrong token → 403 forbidden', () => {
  for (const bad of [undefined, null, '', 'nope', 123, {}]) {
    const res = mutationTokenError(bad, TOKEN);
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'forbidden');
    assert.match(res.json.message, /mutation token/i);
  }
});

test('mutationTokenError: exact matching token → null (pass)', () => {
  assert.equal(mutationTokenError(TOKEN, TOKEN), null);
});

// ── Gate 2: key validation ──────────────────────────────────────────────────

test('mutationKeysError: empty batch → 400 invalid-keys', () => {
  const res = mutationKeysError([], { allowArchive: true });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'invalid-keys');
  assert.ok(Array.isArray(res.json.invalidKeys));
});

test('mutationKeysError: a malformed key poisons the whole batch (400 + invalidKeys)', () => {
  const res = mutationKeysError(['brief-a/run-1', '../etc/passwd'], { allowArchive: true });
  assert.equal(res.status, 400);
  assert.ok(res.json.invalidKeys.includes('../etc/passwd'));
});

test('mutationKeysError: archive op (allowArchive:false) rejects archive-prefixed keys', () => {
  // Active-only, matching the monolith — an archive/ key must not reach archiveRuns.
  const res = mutationKeysError(['archive/brief-a/run-1'], { allowArchive: false });
  assert.equal(res.status, 400);
  assert.ok(res.json.invalidKeys.includes('archive/brief-a/run-1'));
});

test('mutationKeysError: valid active keys (archive op) → null (pass)', () => {
  assert.equal(mutationKeysError(['brief-a/run-1'], { allowArchive: false }), null);
});

test('mutationKeysError: valid archive key (delete op) → null (pass)', () => {
  assert.equal(mutationKeysError(['archive/brief-a/run-1'], { allowArchive: true }), null);
});

// ── Gate 3: sidecar health ──────────────────────────────────────────────────

test('sidecarHealthError: up → null (pass)', () => {
  assert.equal(sidecarHealthError({ state: 'up' }, 'archive'), null);
});

test('sidecarHealthError: down / wrong-repo / missing → 409 sidecar-degraded', () => {
  for (const health of [{ state: 'down' }, { state: 'wrong-repo' }, null, undefined, {}]) {
    const res = sidecarHealthError(health, 'delete');
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'sidecar-degraded');
  }
});

test('sidecarHealthError: refusal message names the verb (parity with monolith routes)', () => {
  assert.match(
    sidecarHealthError({ state: 'down' }, 'archive').json.message,
    /refusing to archive\./,
  );
  assert.match(
    sidecarHealthError({ state: 'down' }, 'delete').json.message,
    /refusing to delete\./,
  );
});

// ── Body-error mapping ──────────────────────────────────────────────────────

test('bodyErrorResult: honors err.statusCode (413) else defaults to 400', () => {
  const oversized = Object.assign(new Error('Request body too large.'), { statusCode: 413 });
  const oversizedResult = bodyErrorResult(oversized);
  assert.equal(oversizedResult.status, 413);
  assert.equal(oversizedResult.json.error, 'bad-request');
  assert.equal(bodyErrorResult(new Error('Invalid JSON body.')).status, 400);
});

// ── decideMutation: ordering + short-circuits (the reviewer's core concern) ──

test('decideMutation: bad token short-circuits — no body read, no health probe, no execute', async () => {
  const { deps, calls } = makeDeps({ token: 'wrong' });
  const res = await decideMutation(deps);
  assert.equal(res.status, 403);
  assert.equal(calls.readBody, 0);
  assert.equal(calls.probeHealth, 0);
  assert.equal(calls.execute, 0);
});

test('decideMutation: body-read failure maps to its status — no health probe, no execute', async () => {
  const { deps, calls } = makeDeps({
    readBody: async () => {
      throw Object.assign(new Error('Request body too large.'), { statusCode: 413 });
    },
  });
  const res = await decideMutation(deps);
  assert.equal(res.status, 413);
  assert.equal(calls.probeHealth, 0);
  assert.equal(calls.execute, 0);
});

test('decideMutation: invalid keys short-circuit — health is NOT probed, execute NOT called', async () => {
  const { deps, calls } = makeDeps({ readBody: async () => ({ keys: [] }) });
  const res = await decideMutation(deps);
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'invalid-keys');
  assert.equal(calls.probeHealth, 0);
  assert.equal(calls.execute, 0);
});

test('decideMutation: archive-prefixed key on an archive op is rejected before execute', async () => {
  const { deps, calls } = makeDeps({
    allowArchive: false,
    readBody: async () => ({ keys: ['archive/brief-a/run-1'] }),
  });
  const res = await decideMutation(deps);
  assert.equal(res.status, 400);
  assert.equal(calls.execute, 0);
});

test('decideMutation: degraded sidecar blocks execute (409) — THE irreversible-op safety gate', async () => {
  const { deps, calls } = makeDeps({ healthState: 'wrong-repo' });
  const res = await decideMutation(deps);
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'sidecar-degraded');
  assert.equal(calls.probeHealth, 1);
  assert.equal(calls.execute, 0); // the mutation must NOT run when health is not up
});

test('decideMutation: token + valid keys + healthy → execute runs with the keys, result relayed', async () => {
  const { deps, calls } = makeDeps({
    readBody: async () => ({ keys: ['brief-a/run-1', 'brief-b/run-2'] }),
  });
  const res = await decideMutation(deps);
  assert.deepEqual(res, {
    json: { ok: true, archived: ['brief-a/run-1', 'brief-b/run-2'], skipped: [] },
  });
  assert.equal(calls.execute, 1);
  assert.deepEqual(calls.executeKeys, ['brief-a/run-1', 'brief-b/run-2']);
});

test('decideMutation: execute throwing maps to 502 <verb>-failed', async () => {
  const { deps } = makeDeps({
    verb: 'delete',
    allowArchive: true,
    readBody: async () => ({ keys: ['archive/brief-a/run-1'] }),
    execute: async () => {
      throw new Error('sidecar 500');
    },
  });
  const res = await decideMutation(deps);
  assert.equal(res.status, 502);
  assert.equal(res.json.error, 'delete-failed');
  assert.match(res.json.message, /sidecar 500/);
});

test('decideMutation: non-array keys body coerces to an empty batch → 400 (never forwards)', async () => {
  const { deps, calls } = makeDeps({ readBody: async () => ({ keys: 'brief-a/run-1' }) });
  const res = await decideMutation(deps);
  assert.equal(res.status, 400);
  assert.equal(calls.execute, 0);
});
