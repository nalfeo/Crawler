import assert from 'node:assert/strict';
import test from 'node:test';

import { createRefreshCoordinator } from '../lib/refresh-coordinator.mjs';

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('shares in-flight work and runs one forced follow-up refresh', async () => {
  const resolvers = [];
  let calls = 0;
  const coordinator = createRefreshCoordinator({
    intervalMs: 60_000,
    load: () => {
      calls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  coordinator.subscribe();

  const first = coordinator.refresh();
  await turn();
  const forced = coordinator.refresh(true);
  assert.equal(calls, 1);
  resolvers[0]({ generation: 1 });
  await turn();
  assert.equal(calls, 2);
  resolvers[1]({ generation: 2 });

  assert.deepEqual(await first, { generation: 2 });
  assert.deepEqual(await forced, { generation: 2 });
  coordinator.unsubscribe();
  coordinator.close();
});

test('clears its timer after the final subscriber leaves', () => {
  const coordinator = createRefreshCoordinator({
    intervalMs: 60_000,
    load: async () => ({}),
  });
  coordinator.subscribe();
  assert.equal(coordinator.timerActive, true);
  coordinator.unsubscribe();
  assert.equal(coordinator.timerActive, false);
  coordinator.close();
});

test('notifies after clearing the in-flight refresh state', async () => {
  let coordinator;
  const states = [];
  coordinator = createRefreshCoordinator({
    load: async () => ({ generation: 1 }),
    onUpdate: () => states.push(coordinator.refreshing),
    onSettled: () => states.push(coordinator.refreshing),
  });
  coordinator.subscribe();

  await coordinator.refresh();

  assert.deepEqual(states, [true, false]);
  coordinator.unsubscribe();
  coordinator.close();
});

test('closing aborts outstanding refresh work without leaking a rejection', async () => {
  let observedSignal;
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  const coordinator = createRefreshCoordinator({
    load: (signal) => {
      observedSignal = signal;
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    },
  });
  coordinator.subscribe();
  const refresh = coordinator.refresh();
  await didStart;
  coordinator.close();
  assert.equal(observedSignal.aborted, true);
  assert.equal(await refresh, null);
});
