import assert from 'node:assert/strict';
import test from 'node:test';
import { startThemeEquipmentReviewServer } from '../lib/server.mjs';

async function fixture(overrides = {}) {
  const commands = [];
  const runCommand = async (command) => {
    commands.push(command);
    if (command.expectedRevision === 99) throw new Error('revision-conflict: expected 99, found 2');
    if (command.action === 'artifact') {
      return { contentType: 'image/png', base64: Buffer.from('png').toString('base64') };
    }
    if (command.action === 'list') {
      return { sets: [{ id: 'classic-fantasy' }, { id: 'pirate' }], storeStatus: 'ok' };
    }
    if (command.action === 'save-plan') return { saved: true, planPath: 'x.json' };
    return { id: 'classic-fantasy', stateRevision: 2 };
  };
  const dispatched = [];
  const server = await startThemeEquipmentReviewServer({
    instanceId: 'review-1',
    setId: 'classic-fantasy',
    renderHtml: ({ token }) => `<html>${token}</html>`,
    runCommand,
    dispatchWorkflow: async (action, setId) => {
      dispatched.push({ action, setId });
      return { dispatched: true, action, setId, ref: 'refs/heads/feature' };
    },
    ...overrides,
  });
  return { ...server, commands, dispatched };
}

test('requires the per-instance token for data access', async () => {
  const server = await fixture();
  try {
    const denied = await fetch(`${server.url}api/state`);
    assert.equal(denied.status, 403);
    const allowed = await fetch(`${server.url}api/state`, {
      headers: { 'X-Canvas-Token': server.token },
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).id, 'classic-fantasy');
  } finally {
    await server.close();
  }
});

test('requires exact loopback origin and JSON content type for mutations', async () => {
  const server = await fixture();
  try {
    const headers = { 'X-Canvas-Token': server.token, 'Content-Type': 'application/json' };
    const crossOrigin = await fetch(`${server.url}api/review-item`, {
      method: 'POST',
      headers: { ...headers, Origin: 'http://127.0.0.1:9' },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);
    const wrongType = await fetch(`${server.url}api/review-item`, {
      method: 'POST',
      headers: {
        'X-Canvas-Token': server.token,
        'Content-Type': 'text/plain',
        Origin: server.url.slice(0, -1),
      },
      body: '{}',
    });
    assert.equal(wrongType.status, 415);
    const accepted = await fetch(`${server.url}api/review-item`, {
      method: 'POST',
      headers: { ...headers, Origin: server.url.slice(0, -1) },
      body: JSON.stringify({
        itemId: 'iron-sword',
        review: { verdict: 'up' },
        expectedRevision: 2,
      }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(server.commands.at(-1), {
      action: 'item-review',
      setId: 'classic-fantasy',
      itemId: 'iron-sword',
      review: { verdict: 'up' },
      expectedRevision: 2,
    });

    const attemptedOverride = await fetch(`${server.url}api/review-item`, {
      method: 'POST',
      headers: { ...headers, Origin: server.url.slice(0, -1) },
      body: JSON.stringify({
        action: 'advance',
        setId: 'other-set',
        itemId: 'iron-sword',
        review: { verdict: 'down' },
        expectedRevision: 2,
      }),
    });
    assert.equal(attemptedOverride.status, 200);
    assert.deepEqual(server.commands.at(-1), {
      action: 'item-review',
      setId: 'classic-fantasy',
      itemId: 'iron-sword',
      review: { verdict: 'down' },
      expectedRevision: 2,
    });
  } finally {
    await server.close();
  }
});

test('surfaces optimistic revision conflicts as HTTP 409', async () => {
  const server = await fixture();
  try {
    const response = await fetch(`${server.url}api/advance`, {
      method: 'POST',
      headers: {
        'X-Canvas-Token': server.token,
        'Content-Type': 'application/json',
        Origin: server.url.slice(0, -1),
      },
      body: JSON.stringify({ expectedRevision: 99 }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /revision-conflict/);
  } finally {
    await server.close();
  }
});

test('proxies only artifact identities through the trusted command bridge', async () => {
  const server = await fixture();
  try {
    const response = await fetch(
      `${server.url}api/artifact?itemId=iron-sword&artifactId=iron-sword-sheet-r0-raw`,
      { headers: { 'X-Canvas-Token': server.token } },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'png');
    assert.deepEqual(server.commands.at(-1), {
      action: 'artifact',
      setId: 'classic-fantasy',
      itemId: 'iron-sword',
      artifactId: 'iron-sword-sheet-r0-raw',
    });
  } finally {
    await server.close();
  }
});

test('opens with no set selected and refuses state until one is chosen', async () => {
  const server = await fixture({ setId: null });
  const headers = {
    'X-Canvas-Token': server.token,
    'Content-Type': 'application/json',
    Origin: null,
  };
  headers.Origin = server.url.slice(0, -1);
  try {
    assert.equal(server.getSetId(), null);
    const denied = await fetch(`${server.url}api/state`, {
      headers: { 'X-Canvas-Token': server.token },
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, 'no-set-selected');

    const dispatchDenied = await fetch(`${server.url}api/dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'init' }),
    });
    assert.equal(dispatchDenied.status, 409);
    assert.equal(server.dispatched.length, 0);

    const artifactDenied = await fetch(`${server.url}api/artifact?itemId=a&artifactId=b`, {
      headers: { 'X-Canvas-Token': server.token },
    });
    assert.equal(artifactDenied.status, 409);
  } finally {
    await server.close();
  }
});

test('selects a set only from the server-computed allowlist', async () => {
  const server = await fixture({ setId: null });
  const headers = {
    'X-Canvas-Token': server.token,
    'Content-Type': 'application/json',
    Origin: server.url.slice(0, -1),
  };
  try {
    const traversal = await fetch(`${server.url}api/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ setId: '../../etc/passwd' }),
    });
    assert.equal(traversal.status, 400);

    const unknown = await fetch(`${server.url}api/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ setId: 'not-authored' }),
    });
    assert.equal(unknown.status, 404);
    assert.equal(server.getSetId(), null);

    const accepted = await fetch(`${server.url}api/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ setId: 'pirate' }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(server.getSetId(), 'pirate');

    const dispatch = await fetch(`${server.url}api/dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'init' }),
    });
    assert.equal(dispatch.status, 200);
    assert.deepEqual(server.dispatched.at(-1), { action: 'init', setId: 'pirate' });
  } finally {
    await server.close();
  }
});

test('validates a caller-supplied initial set id against the same allowlist', async () => {
  const unknown = await fixture({ setId: 'not-authored' });
  const authored = await fixture({ setId: 'pirate' });
  try {
    // An arbitrary kebab-case id from canvas open input must not bind the
    // instance; the canvas falls back to its set index instead.
    assert.equal(unknown.getSetId(), null);
    const state = await fetch(`${unknown.url}api/state`, {
      headers: { 'X-Canvas-Token': unknown.token },
    });
    assert.equal(state.status, 409);

    assert.equal(authored.getSetId(), 'pirate');
  } finally {
    await unknown.close();
    await authored.close();
  }
});

test('save-plan forwards only the plan and overwrite flag, never a path', async () => {
  const server = await fixture();
  const headers = {
    'X-Canvas-Token': server.token,
    'Content-Type': 'application/json',
    Origin: server.url.slice(0, -1),
  };
  try {
    const response = await fetch(`${server.url}api/save-plan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        plan: { id: 'pirate' },
        overwrite: true,
        planPath: '../../../evil.json',
        setId: 'other-set',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(server.commands.at(-1), {
      action: 'save-plan',
      plan: { id: 'pirate' },
      overwrite: true,
    });
  } finally {
    await server.close();
  }
});

test('synth-roster forwards only the four brief fields', async () => {
  const server = await fixture();
  const headers = {
    'X-Canvas-Token': server.token,
    'Content-Type': 'application/json',
    Origin: server.url.slice(0, -1),
  };
  try {
    const response = await fetch(`${server.url}api/synth-roster`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        setId: 'edo-samurai',
        displayName: 'Edo Samurai',
        themeDesignLanguage: 'Lacquered indigo plate with silk cord lacing and muted gold crests.',
        notes: 'Favor polearms.',
        plan: { id: 'injected' },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(server.commands.at(-1), {
      action: 'synth-roster',
      setId: 'edo-samurai',
      displayName: 'Edo Samurai',
      themeDesignLanguage: 'Lacquered indigo plate with silk cord lacing and muted gold crests.',
      notes: 'Favor polearms.',
    });
  } finally {
    await server.close();
  }
});

test('reuses one list result for concurrent and closely-spaced callers', async () => {
  const server = await fixture();
  try {
    const headers = { 'X-Canvas-Token': server.token };
    await Promise.all([
      fetch(`${server.url}api/sets`, { headers }),
      fetch(`${server.url}api/sets`, { headers }),
    ]);
    await fetch(`${server.url}api/sets`, { headers });
    // One for the startup allowlist check, one shared by every read after it.
    assert.equal(server.commands.filter((command) => command.action === 'list').length, 1);
  } finally {
    await server.close();
  }
});

test('expires the list cache so a new set becomes visible', async () => {
  const server = await fixture({ listTtlMs: 10 });
  try {
    const headers = { 'X-Canvas-Token': server.token };
    await fetch(`${server.url}api/sets`, { headers });
    await new Promise((done) => setTimeout(done, 25));
    await fetch(`${server.url}api/sets`, { headers });
    assert.ok(server.commands.filter((command) => command.action === 'list').length >= 2);
  } finally {
    await server.close();
  }
});

test('invalidates the list cache after a plan is saved', async () => {
  const server = await fixture();
  try {
    const headers = { 'X-Canvas-Token': server.token, 'Content-Type': 'application/json' };
    await fetch(`${server.url}api/sets`, { headers: { 'X-Canvas-Token': server.token } });
    const before = server.commands.filter((command) => command.action === 'list').length;
    await fetch(`${server.url}api/save-plan`, {
      method: 'POST',
      headers: { ...headers, Origin: new URL(server.url).origin },
      body: JSON.stringify({ plan: { id: 'pirate' } }),
    });
    await fetch(`${server.url}api/sets`, { headers: { 'X-Canvas-Token': server.token } });
    assert.equal(server.commands.filter((command) => command.action === 'list').length, before + 1);
  } finally {
    await server.close();
  }
});

test('broadcasts state once an init dispatch produces it', async () => {
  let hasState = false;
  const server = await fixture({
    watchIntervalMs: 10,
    runCommand: async (command) => {
      if (command.action === 'list')
        return { sets: [{ id: 'classic-fantasy' }], storeStatus: 'ok' };
      if (command.action === 'state') {
        if (!hasState) throw new Error('State for "classic-fantasy" was not found.');
        return { id: 'classic-fantasy', stateRevision: 1 };
      }
      return {};
    },
  });
  try {
    const events = await fetch(`${server.url}events?token=${encodeURIComponent(server.token)}`);
    const reader = events.body.getReader();
    await reader.read();
    await fetch(`${server.url}api/dispatch`, {
      method: 'POST',
      headers: {
        'X-Canvas-Token': server.token,
        'Content-Type': 'application/json',
        Origin: new URL(server.url).origin,
      },
      body: JSON.stringify({ action: 'init' }),
    });
    hasState = true;
    const chunk = await reader.read();
    const payload = new TextDecoder().decode(chunk.value);
    assert.match(payload, /"stateRevision":1/);
    await reader.cancel().catch(() => {});
  } finally {
    await server.close();
  }
});

test('stops watching when the store fails rather than retrying for twenty minutes', async () => {
  let stateCalls = 0;
  const warnings = [];
  const server = await fixture({
    watchIntervalMs: 10,
    log: (message, level) => warnings.push({ message, level }),
    runCommand: async (command) => {
      if (command.action === 'list')
        return { sets: [{ id: 'classic-fantasy' }], storeStatus: 'ok' };
      if (command.action === 'state') {
        stateCalls += 1;
        throw new Error('AuthenticationFailed: server failed to authenticate the request');
      }
      return {};
    },
  });
  try {
    await fetch(`${server.url}api/dispatch`, {
      method: 'POST',
      headers: {
        'X-Canvas-Token': server.token,
        'Content-Type': 'application/json',
        Origin: new URL(server.url).origin,
      },
      body: JSON.stringify({ action: 'init' }),
    });
    await new Promise((done) => setTimeout(done, 80));
    assert.equal(stateCalls, 1, 'an unrecoverable store error must stop the watch immediately');
    assert.ok(warnings.some((entry) => /state watch .* stopped/.test(entry.message)));
  } finally {
    await server.close();
  }
});

test('a non-init dispatch does not start a watch', async () => {
  const server = await fixture({ watchIntervalMs: 10 });
  try {
    await fetch(`${server.url}api/dispatch`, {
      method: 'POST',
      headers: {
        'X-Canvas-Token': server.token,
        'Content-Type': 'application/json',
        Origin: new URL(server.url).origin,
      },
      body: JSON.stringify({ action: 'run-phase' }),
    });
    const before = server.commands.filter((command) => command.action === 'state').length;
    await new Promise((done) => setTimeout(done, 60));
    assert.equal(server.commands.filter((command) => command.action === 'state').length, before);
  } finally {
    await server.close();
  }
});

test('watches the set that was dispatched even if the selection changes mid-flight', async () => {
  let releaseDispatch;
  const gate = new Promise((resolve) => {
    releaseDispatch = resolve;
  });
  const watched = [];
  const server = await fixture({
    watchIntervalMs: 10,
    dispatchWorkflow: async (action, forSetId) => {
      await gate;
      return { dispatched: true, action, setId: forSetId };
    },
    runCommand: async (command) => {
      if (command.action === 'list') {
        return { sets: [{ id: 'classic-fantasy' }, { id: 'pirate' }], storeStatus: 'ok' };
      }
      if (command.action === 'state') {
        watched.push(command.setId);
        throw new Error(`State for "${command.setId}" was not found.`);
      }
      return {};
    },
  });
  try {
    const headers = {
      'X-Canvas-Token': server.token,
      'Content-Type': 'application/json',
      Origin: new URL(server.url).origin,
    };
    const dispatch = fetch(`${server.url}api/dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'init' }),
    });
    // The user navigates to another set while the dispatch is still in flight.
    await fetch(`${server.url}api/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ setId: 'pirate' }),
    });
    releaseDispatch();
    await dispatch;
    await new Promise((done) => setTimeout(done, 40));
    assert.ok(watched.length > 0, 'the watch must actually run');
    assert.deepEqual([...new Set(watched)], ['classic-fantasy']);
  } finally {
    await server.close();
  }
});

test('run-status route reports not-wired when no runStatus provider is configured', async () => {
  const server = await fixture();
  try {
    const res = await fetch(`${server.url}api/run-status`, {
      headers: { 'X-Canvas-Token': server.token },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { available: false, errorKind: 'not-wired' });
  } finally {
    await server.close();
  }
});

test('run-status route forwards the server-side set id to the provider', async () => {
  const seen = [];
  const server = await fixture({
    runStatus: async (id) => {
      seen.push(id);
      return { available: true, run: null, ref: 'refs/heads/feature' };
    },
  });
  try {
    // A caller-supplied ?setId is ignored — the server uses its own selection.
    const res = await fetch(`${server.url}api/run-status?setId=spoofed`, {
      headers: { 'X-Canvas-Token': server.token },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { available: true, run: null, ref: 'refs/heads/feature' });
    assert.deepEqual(seen, ['classic-fantasy']);
  } finally {
    await server.close();
  }
});

test('run-status route returns 409 when no set is selected', async () => {
  const server = await fixture({ setId: null });
  try {
    const res = await fetch(`${server.url}api/run-status`, {
      headers: { 'X-Canvas-Token': server.token },
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'no-set-selected' });
  } finally {
    await server.close();
  }
});
