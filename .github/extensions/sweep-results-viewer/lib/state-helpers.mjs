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

export function isCurrentCloudGeneration(state, generation) {
  return !state.closed && state.generation === generation && state.source === 'cloud';
}

export function isCurrentLocalSelection(state, selection) {
  return (
    !state.closed &&
    state.generation === selection.generation &&
    state.source === 'local' &&
    state.path === selection.path
  );
}

export async function stabilizeTerminalSnapshot(snapshot, options) {
  const { attempts, delayMs, signal, isTerminalRun, loadSnapshot, sleep = defaultSleep } = options;
  if (!isTerminalRun(snapshot.run)) return snapshot;
  let current = snapshot;
  for (let attempt = 0; attempt < Math.max(0, attempts - 1); attempt += 1) {
    const complete =
      current.expectedWeapons.length > 0 &&
      current.aggregateOutputs.length >= current.expectedWeapons.length;
    if (complete || current.expiredArtifactCount > 0) {
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
