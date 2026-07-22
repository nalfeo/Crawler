export function createRefreshCoordinator({
  load,
  intervalMs = 30_000,
  onUpdate,
  onError,
  onSettled,
}) {
  let snapshot = null;
  let error = null;
  let inFlight = null;
  let controller = null;
  let timer = null;
  let followUpRequested = false;
  let subscribers = 0;
  let closed = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleAfter(delayMs) {
    clearTimer();
    if (closed || subscribers === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh().catch(() => {});
    }, delayMs);
    timer.unref?.();
  }

  function schedule() {
    scheduleAfter(intervalMs);
  }

  async function runLoop() {
    let lastError = null;
    do {
      followUpRequested = false;
      controller = new AbortController();
      lastError = null;
      try {
        snapshot = await load(controller.signal);
        error = null;
        onUpdate?.(snapshot);
      } catch (refreshError) {
        if (refreshError?.name === 'AbortError' && closed) return snapshot;
        error = refreshError instanceof Error ? refreshError.message : String(refreshError);
        onError?.(error);
        lastError = refreshError;
      } finally {
        controller = null;
      }
    } while (followUpRequested && !closed && subscribers > 0);
    if (lastError) throw lastError;
    return snapshot;
  }

  async function refresh(force = false) {
    if (closed) throw new Error('Refresh coordinator is closed.');
    if (inFlight) {
      if (force) followUpRequested = true;
      return inFlight;
    }
    clearTimer();
    const startMs = Date.now();
    inFlight = runLoop().finally(() => {
      inFlight = null;
      const elapsed = Date.now() - startMs;
      scheduleAfter(Math.max(0, intervalMs - elapsed));
      onSettled?.();
    });
    return inFlight;
  }

  function subscribe() {
    if (closed) throw new Error('Refresh coordinator is closed.');
    subscribers += 1;
    if (subscribers === 1) schedule();
  }

  function unsubscribe() {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0) clearTimer();
  }

  function close() {
    closed = true;
    clearTimer();
    controller?.abort();
  }

  return {
    refresh,
    subscribe,
    unsubscribe,
    close,
    get snapshot() {
      return snapshot;
    },
    get error() {
      return error;
    },
    get refreshing() {
      return Boolean(inFlight);
    },
    get subscribers() {
      return subscribers;
    },
    get timerActive() {
      return Boolean(timer);
    },
  };
}
