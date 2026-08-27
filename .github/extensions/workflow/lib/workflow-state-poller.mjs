import { clearInterval, setInterval } from 'node:timers';

const noopLog = () => {};

/**
 * Run one durable-state read and hand that exact snapshot to the poll-specific
 * refresh logic. The refresh may conditionally write with the returned ETag,
 * but must not perform another read during the same uncontended poll tick.
 */
export async function runWorkflowStatePoll(source, refreshFromRemote) {
  const remote = await source.client.getWorkflowState();
  return refreshFromRemote(source, remote);
}

/**
 * Coordinate one process-wide workflow-state poll across every live canvas.
 * Mutable workflow state remains instance-owned; this object retains only live
 * subscriptions, timer lifecycle, and an invalidation epoch.
 */
export function createWorkflowStatePoller({
  poll,
  intervalMs = 10_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  log = noopLog,
}) {
  if (typeof poll !== 'function') {
    throw new TypeError('createWorkflowStatePoller requires a poll(source) function');
  }

  const subscribers = new Map();
  let timer = null;
  let inFlight = null;
  let invalidationEpoch = 0;

  function stopTimer() {
    if (!timer) return;
    clearIntervalImpl(timer);
    timer = null;
  }

  function ensureTimer() {
    if (timer || subscribers.size === 0) return;
    timer = setIntervalImpl(() => {
      void tick().catch((error) => {
        log(`workflow Azure refresh failed: ${error?.message ?? error}`, 'warn');
      });
    }, intervalMs);
    timer?.unref?.();
  }

  async function runTick() {
    const targets = [...subscribers.entries()];
    if (targets.length === 0) return { reads: 0, delivered: 0, invalidated: false };

    const epochAtStart = invalidationEpoch;
    const source = targets[0][1];
    const snapshot = await poll(source);
    if (invalidationEpoch !== epochAtStart) {
      return { reads: 1, delivered: 0, invalidated: true };
    }

    let delivered = 0;
    for (const [instanceId, subscriber] of targets) {
      if (invalidationEpoch !== epochAtStart) break;
      if (subscribers.get(instanceId) !== subscriber) continue;
      const isCurrent = () =>
        invalidationEpoch === epochAtStart && subscribers.get(instanceId) === subscriber;
      try {
        await subscriber.onSnapshot(snapshot, { source: subscriber === source, isCurrent });
        delivered += 1;
      } catch (error) {
        log(`workflow state poll delivery failed: ${error?.message ?? error}`, 'warn');
      }
    }
    return { reads: 1, delivered, invalidated: invalidationEpoch !== epochAtStart };
  }

  async function tick() {
    if (inFlight) return inFlight;
    const execution = runTick();
    inFlight = execution;
    try {
      return await execution;
    } finally {
      if (inFlight === execution) inFlight = null;
    }
  }

  function subscribe(instanceId, subscriber) {
    if (!instanceId || typeof subscriber?.onSnapshot !== 'function') {
      throw new TypeError('workflow poll subscribers require an id and onSnapshot callback');
    }
    subscribers.set(instanceId, subscriber);
    ensureTimer();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (subscribers.get(instanceId) === subscriber) subscribers.delete(instanceId);
      if (subscribers.size === 0) stopTimer();
    };
  }

  function invalidate() {
    invalidationEpoch += 1;
  }

  function close() {
    invalidationEpoch += 1;
    subscribers.clear();
    stopTimer();
  }

  return {
    subscribe,
    invalidate,
    tick,
    close,
    get size() {
      return subscribers.size;
    },
    get running() {
      return timer !== null;
    },
  };
}
