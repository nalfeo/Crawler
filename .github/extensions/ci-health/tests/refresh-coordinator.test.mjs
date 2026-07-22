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

test('runs a forced follow-up refresh after a failing poll', async () => {
  const resolvers = [];
  const rejecters = [];
  let calls = 0;
  const errors = [];
  const coordinator = createRefreshCoordinator({
    intervalMs: 60_000,
    load: () => {
      calls += 1;
      return new Promise((resolve, reject) => {
        resolvers.push(resolve);
        rejecters.push(reject);
      });
    },
    onError: (message) => errors.push(message),
  });
  coordinator.subscribe();

  const first = coordinator.refresh();
  await turn();
  const forced = coordinator.refresh(true);
  assert.equal(calls, 1);

  // Fail the first iteration; the forced follow-up must still run.
  rejecters[0](new Error('network error'));
  await turn();
  assert.equal(calls, 2, 'second iteration must start after the first fails');

  // Resolve the follow-up successfully.
  resolvers[1]({ generation: 2 });

  // Both callers receive the follow-up result; no rejection is propagated.
  assert.deepEqual(await first, { generation: 2 });
  assert.deepEqual(await forced, { generation: 2 });
  assert.equal(errors.length, 1, 'onError must have been called once for the failing iteration');
  assert.match(errors[0], /network error/);

  coordinator.unsubscribe();
  coordinator.close();
});
