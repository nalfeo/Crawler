import assert from 'node:assert/strict';
import test from 'node:test';
import { startThemeEquipmentReviewServer } from '../lib/server.mjs';

async function fixture() {
  const commands = [];
  const runCommand = async (command) => {
    commands.push(command);
    if (command.expectedRevision === 99) throw new Error('revision-conflict: expected 99, found 2');
    if (command.action === 'artifact') {
      return { contentType: 'image/png', base64: Buffer.from('png').toString('base64') };
    }
    return { id: 'classic-fantasy', stateRevision: 2 };
  };
  const server = await startThemeEquipmentReviewServer({
    instanceId: 'review-1',
    setId: 'classic-fantasy',
    renderHtml: ({ token }) => `<html>${token}</html>`,
    runCommand,
    dispatchWorkflow: async (action) => ({ dispatched: true, action }),
  });
  return { ...server, commands };
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
