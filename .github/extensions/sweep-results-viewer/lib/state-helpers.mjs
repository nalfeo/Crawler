function toErrorText(error) {
  return error instanceof Error ? error.message : String(error ?? '');
}

function withSentencePunctuation(message) {
  const trimmed = message.trim();
  if (!trimmed) return 'Unknown error.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function isAuthenticationError(error) {
  const message = toErrorText(error).toLowerCase();
  return [
    'gh auth login',
    'not logged into any github hosts',
    'authentication',
    'bad credentials',
    'http 401',
    'http 403',
    'forbidden',
    'requires authentication',
  ].some((fragment) => message.includes(fragment));
}

export function formatCloudFailure(prefix, error) {
  const detail = withSentencePunctuation(toErrorText(error));
  const authGuidance = isAuthenticationError(error)
    ? ' Authenticate with "gh auth login" and retry.'
    : '';
  return `${prefix}${detail}${authGuidance}`;
}

export function isCurrentLocalSelection(state, selection) {
  return (
    !state.closed &&
    state.generation === selection.generation &&
    state.source === 'local' &&
    state.path === selection.path
  );
}

/**
 * Default completeness check for weapon-sweep snapshots.
 * Returns true when all expected weapon aggregates have arrived or an artifact expired.
 */
function defaultIsComplete(snapshot) {
  return (
    (snapshot.expectedWeapons?.length > 0 &&
      snapshot.aggregateOutputs?.length >= snapshot.expectedWeapons?.length) ||
    snapshot.expiredArtifactCount > 0
  );
}

export async function stabilizeTerminalSnapshot(snapshot, options) {
  const {
    attempts,
    delayMs,
    signal,
    isTerminalRun,
    loadSnapshot,
    isComplete = defaultIsComplete,
    sleep = defaultSleep,
  } = options;
  if (!isTerminalRun(snapshot.run)) return snapshot;
  let current = snapshot;
  for (let attempt = 0; attempt < Math.max(0, attempts - 1); attempt += 1) {
    if (isComplete(current)) {
      break;
    }
    await sleep(delayMs, signal);
    current = await loadSnapshot(signal);
  }
  return current;
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });
}
