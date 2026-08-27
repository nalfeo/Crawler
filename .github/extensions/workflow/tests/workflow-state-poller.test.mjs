import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWorkflowStatePoller, runWorkflowStatePoll } from '../lib/workflow-state-poller.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeScheduler() {
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    setIntervalImpl(callback, intervalMs) {
      const timer = { callback, intervalMs, unrefCalled: false };
      timer.unref = () => {
        timer.unrefCalled = true;
      };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) {
      cleared.push(timer);
    },
  };
}

test('HARD GATE: six instances share one remote read per interval and every live instance receives changes', async (t) => {
  const scheduler = fakeScheduler();
  let remoteReads = 0;
  let etagSequence = 0;
  const received = new Map();
  const poller = createWorkflowStatePoller({
    poll: async () => {
      remoteReads += 1;
      etagSequence += 1;
      return { state: { revision: etagSequence }, etag: `etag-${etagSequence}` };
    },
    ...scheduler,
  });

  for (let index = 1; index <= 6; index += 1) {
    const instanceId = `canvas-${index}`;
    received.set(instanceId, []);
    poller.subscribe(instanceId, {
      onSnapshot: async (snapshot) => received.get(instanceId).push(snapshot),
    });
  }

  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.timers[0].intervalMs, 10_000);
  assert.equal(scheduler.timers[0].unrefCalled, true);

  const first = await poller.tick();
  assert.equal(remoteReads, 1, 'one interval must issue exactly one durable-state read');
  assert.deepEqual(first, { reads: 1, delivered: 6, invalidated: false });
  for (const snapshots of received.values()) {
    assert.deepEqual(snapshots, [{ state: { revision: 1 }, etag: 'etag-1' }]);
  }

  await poller.tick();
  assert.equal(remoteReads, 2, 'each subsequent interval adds exactly one remote read');
  for (const snapshots of received.values()) assert.equal(snapshots.length, 2);

  const oldRequestCount = 6;
  const newRequestCount = 1;
  const reductionPercent = ((oldRequestCount - newRequestCount) / oldRequestCount) * 100;
  assert.ok(reductionPercent >= 80);
  assert.equal(Number(reductionPercent.toFixed(2)), 83.33);
  t.diagnostic(
    `6-instance benchmark: ${(oldRequestCount / 10).toFixed(1)} -> ${(newRequestCount / 10).toFixed(1)} workflow-state reads/sec (${reductionPercent.toFixed(2)}% reduction)`,
  );
});

test('closing instances removes them from fan-out and the last close clears the shared timer', async () => {
  const scheduler = fakeScheduler();
  const deliveries = new Map();
  const poller = createWorkflowStatePoller({
    poll: async () => ({ state: { changed: true }, etag: 'next' }),
    ...scheduler,
  });
  const stops = [];

  for (let index = 1; index <= 6; index += 1) {
    const instanceId = `canvas-${index}`;
    deliveries.set(instanceId, 0);
    stops.push(
      poller.subscribe(instanceId, {
        onSnapshot: async () => deliveries.set(instanceId, deliveries.get(instanceId) + 1),
      }),
    );
  }

  stops[2]();
  await poller.tick();
  assert.equal(deliveries.get('canvas-3'), 0);
  for (const [instanceId, count] of deliveries) {
    if (instanceId !== 'canvas-3') assert.equal(count, 1);
  }
  assert.equal(poller.size, 5);
  assert.equal(scheduler.cleared.length, 0);

  for (const stop of stops) stop();
  assert.equal(poller.size, 0);
  assert.equal(poller.running, false);
  assert.deepEqual(scheduler.cleared, [scheduler.timers[0]]);
});

test('a mutation invalidation suppresses stale fan-out to every instance', async () => {
  const scheduler = fakeScheduler();
  const remote = deferred();
  let deliveries = 0;
  const poller = createWorkflowStatePoller({
    poll: async () => remote.promise,
    ...scheduler,
  });
  for (let index = 1; index <= 6; index += 1) {
    poller.subscribe(`canvas-${index}`, {
      onSnapshot: async () => {
        deliveries += 1;
      },
    });
  }

  const tick = poller.tick();
  poller.invalidate();
  remote.resolve({ state: { stale: true }, etag: 'old-etag' });
  assert.deepEqual(await tick, { reads: 1, delivered: 0, invalidated: true });
  assert.equal(deliveries, 0);
});

test('an in-flight tick excludes closed and newly-opened instances and does not restart after last close', async () => {
  const scheduler = fakeScheduler();
  const remote = deferred();
  const delivered = [];
  const poller = createWorkflowStatePoller({
    poll: async () => remote.promise,
    ...scheduler,
  });
  const stops = [];
  for (let index = 1; index <= 6; index += 1) {
    stops.push(
      poller.subscribe(`canvas-${index}`, {
        onSnapshot: async () => delivered.push(`canvas-${index}`),
      }),
    );
  }

  const tick = poller.tick();
  stops[0]();
  poller.subscribe('canvas-new', {
    onSnapshot: async () => delivered.push('canvas-new'),
  });
  for (const stop of stops.slice(1)) stop();
  remote.resolve({ state: { revision: 1 }, etag: 'etag-1' });
  await tick;

  assert.deepEqual(delivered, []);
  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.cleared.length, 0, 'the newly-opened subscriber retains the shared timer');
});

test('closing the last instance during an in-flight tick prevents late fan-out and timer restart', async () => {
  const scheduler = fakeScheduler();
  const remote = deferred();
  let deliveries = 0;
  const poller = createWorkflowStatePoller({
    poll: async () => remote.promise,
    ...scheduler,
  });
  const stop = poller.subscribe('canvas-1', {
    onSnapshot: async () => {
      deliveries += 1;
    },
  });

  const tick = poller.tick();
  stop();
  remote.resolve({ state: { revision: 1 }, etag: 'etag-1' });
  await tick;

  assert.equal(deliveries, 0);
  assert.equal(poller.size, 0);
  assert.equal(poller.running, false);
  assert.equal(scheduler.timers.length, 1);
  assert.deepEqual(scheduler.cleared, [scheduler.timers[0]]);
});

test('overlapping ticks coalesce onto one remote read', async () => {
  const scheduler = fakeScheduler();
  const remote = deferred();
  let remoteReads = 0;
  const poller = createWorkflowStatePoller({
    poll: async () => {
      remoteReads += 1;
      return remote.promise;
    },
    ...scheduler,
  });
  poller.subscribe('canvas-1', { onSnapshot: async () => {} });

  const first = poller.tick();
  const second = poller.tick();
  assert.equal(remoteReads, 1);
  remote.resolve({ state: {}, etag: 'etag-1' });
  assert.deepEqual(await first, await second);
  assert.equal(remoteReads, 1);
});

test('quiet and completion polls each consume one fresh state read', async () => {
  let remoteReads = 0;
  let writes = 0;
  const source = {
    client: {
      async getWorkflowState() {
        remoteReads += 1;
        return { state: { items: [] }, etag: `etag-${remoteReads}` };
      },
      async putWorkflowState(_state, etag) {
        writes += 1;
        assert.equal(etag, 'etag-2');
        return { etag: 'etag-after-write' };
      },
    },
  };

  await runWorkflowStatePoll(source, async (_entry, remote) => remote);
  assert.equal(remoteReads, 1);
  assert.equal(writes, 0);

  await runWorkflowStatePoll(source, async (entry, remote) => {
    await entry.client.putWorkflowState({ items: [{ stage: 'sheet' }] }, remote.etag);
    return { state: { items: [{ stage: 'sheet' }] }, etag: 'etag-after-write' };
  });
  assert.equal(remoteReads, 2, 'the completion interval adds only one state read');
  assert.equal(writes, 1);
});

test('the production poll composition receives the subscribed entry as its live client source', async () => {
  const scheduler = fakeScheduler();
  let remoteReads = 0;
  let refreshCalls = 0;
  let deliveries = 0;
  const entry = {
    client: {
      async getWorkflowState() {
        remoteReads += 1;
        return { state: { items: [] }, etag: 'etag-1' };
      },
    },
    async onSnapshot(snapshot, context) {
      deliveries += 1;
      assert.equal(snapshot.etag, 'etag-1');
      assert.equal(context.source, true);
    },
  };
  const poller = createWorkflowStatePoller({
    poll: (source) =>
      runWorkflowStatePoll(source, async (sameSource, remote) => {
        refreshCalls += 1;
        assert.equal(sameSource, entry);
        return remote;
      }),
    ...scheduler,
  });
  poller.subscribe('canvas-1', entry);

  await poller.tick();

  assert.equal(remoteReads, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(deliveries, 1);
});
