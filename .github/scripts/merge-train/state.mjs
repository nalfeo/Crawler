import { createHash } from 'node:crypto';

export const QUEUE_LABEL = 'merge-train';
export const BLOCKED_LABEL = 'merge-train-blocked';
export const NOOP_LABEL = 'merge-train-noop';
export const CANDIDATE_CHECK_NAME = 'merge-train-candidate';
export const REQUIRED_CHECK_NAME = 'merge-train';
export const STATUS_MARKER = '<!-- crawler-merge-train:v1 -->';
export const VALIDATION_FAILED_LABEL = 'merge-train-validation-failed';
export const DEFAULT_ADMISSION_CHECKS = ['ci', 'Security checks'];
export const MAX_TRAIN_SIZE = 6;

function compact(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function parseEnabledFlag(value) {
  // Do not trim — exact match is required for consistency with workflow
  // expressions (vars.MERGE_TRAIN_ENABLED == 'true') and the shell guard
  // (case "$train_enabled" in true|false). Whitespace-padded values must
  // fail validation to prevent split-brain rollout.
  const normalized = String(value || 'false').replace(/\s+/g, ' ');
  if (!['true', 'false'].includes(normalized)) {
    throw new Error(`MERGE_TRAIN_ENABLED must be true or false, received: ${normalized}`);
  }
  return normalized === 'true';
}

export function hasLeadingMarker(body, marker) {
  return String(body || '')
    .trimStart()
    .startsWith(marker);
}

export function resolveAdmissionChecks(value, defaults = DEFAULT_ADMISSION_CHECKS) {
  const checks = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
  return checks.length > 0 ? checks : [...defaults];
}

export function queueEntries(pullRequests, repository) {
  return pullRequests
    .filter(
      (pr) =>
        pr.state === 'open' &&
        !pr.draft &&
        pr.base?.ref === 'main' &&
        pr.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
        (pr.labels || []).some((label) => label.name === QUEUE_LABEL) &&
        !(pr.labels || []).some((label) => label.name === BLOCKED_LABEL),
    )
    .sort(
      (left, right) =>
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
        left.number - right.number,
    );
}

export function candidateFingerprint(baseSha, entries) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        baseSha: compact(baseSha),
        entries: entries.map((entry) => ({
          number: entry.number,
          headSha: compact(entry.head?.sha),
          title: compact(entry.title),
        })),
      }),
    )
    .digest('hex');
}

export function candidateRef(slot, fingerprint) {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_TRAIN_SIZE) {
    throw new Error(`Invalid merge-train slot: ${slot}`);
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('Candidate fingerprint must be a SHA-256 hex digest');
  }
  return `merge-train/candidate-${slot}-${fingerprint.slice(0, 16)}`;
}

export function admissionFingerprint({
  headSha,
  title,
  baseRef,
  checkRuns,
  requiredNames = DEFAULT_ADMISSION_CHECKS,
  reviewThreads,
}) {
  const checks = latestChecksByName(checkRuns);
  const requiredChecks = requiredNames
    .map((name) => {
      const check = checks.get(name.toLowerCase());
      return {
        name: name.toLowerCase(),
        id: Number(check?.id || 0),
        status: compact(check?.status),
        conclusion: compact(check?.conclusion),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const threads = (reviewThreads || [])
    .map((thread) => ({
      id: compact(thread.id),
      resolved: Boolean(thread.isResolved),
      comments: (thread.comments?.nodes || []).map((comment) => ({
        id: compact(comment.id),
        body: String(comment.body || ''),
        author: compact(comment.author?.login),
      })),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256')
    .update(
      JSON.stringify({
        headSha: compact(headSha),
        title: compact(title),
        baseRef: compact(baseRef),
        requiredChecks,
        threads,
      }),
    )
    .digest('hex');
}

export function nextBisectStep(prefixStates) {
  if (!Array.isArray(prefixStates) || prefixStates.length === 0) {
    throw new Error('At least one prefix state is required');
  }
  const total = prefixStates.length;
  if (prefixStates[total - 1] !== 'failure') {
    return { type: 'validate', prefixLength: total };
  }
  let red = total;
  let green = 0;
  for (let index = 0; index < total - 1; index += 1) {
    if (prefixStates[index] === 'success') {
      green = Math.max(green, index + 1);
    }
  }
  for (let index = green; index < total - 1; index += 1) {
    if (prefixStates[index] === 'failure') {
      red = Math.min(red, index + 1);
    }
  }
  if (red - green === 1) {
    return { type: 'isolate', greenPrefixLength: green, failingPrefixLength: red };
  }
  return { type: 'validate', prefixLength: Math.floor((green + red) / 2) };
}

export function commitTimestamp(entry) {
  const digest = createHash('sha256')
    .update(`${entry.number}\0${compact(entry.head?.sha)}\0${compact(entry.title)}`)
    .digest();
  const seconds = 1735689600 + (digest.readUInt32BE(0) % 31536000);
  return `@${seconds}`;
}

export function latestChecksByName(checkRuns) {
  const checks = new Map();
  for (const check of checkRuns) {
    const name = compact(check.name).toLowerCase();
    const existing = checks.get(name);
    if (!existing || Number(check.id) > Number(existing.id)) {
      checks.set(name, check);
    }
  }
  return checks;
}

export function unsatisfiedChecks(checkRuns, requiredNames = DEFAULT_ADMISSION_CHECKS) {
  const checks = latestChecksByName(checkRuns);
  return requiredNames.filter((name) => {
    const check = checks.get(name.toLowerCase());
    return check?.status !== 'completed' || check.conclusion !== 'success';
  });
}

export function successfulChecks(checkRuns, requiredNames = DEFAULT_ADMISSION_CHECKS) {
  return unsatisfiedChecks(checkRuns, requiredNames).length === 0;
}

// A candidate check normally completes within the validator's own
// `verify` timeout (20 minutes) plus the trivial time the `publish` job
// needs to mint an App token and post the completed check. If the
// `publish` job's app-token/checks.create step itself fails (secrets
// misconfigured, transient API error), no completed check is ever posted
// and the candidate would otherwise stay "pending" forever. Past this
// bound, treat the stale pending check the same as "missing" so the next
// reconciliation redispatches validation instead of waiting indefinitely.
export const CANDIDATE_VALIDATION_STALE_MS = 40 * 60 * 1000;

export function trainCheckState(checkRuns, fingerprint, trustedAppId, now = new Date()) {
  const check = latestChecksByName(
    checkRuns.filter(
      (candidate) =>
        compact(candidate.name).toLowerCase() === CANDIDATE_CHECK_NAME &&
        candidate.external_id === fingerprint &&
        Number(candidate.app?.id) === Number(trustedAppId),
    ),
  ).get(CANDIDATE_CHECK_NAME);
  if (!check) return 'missing';
  if (check.status !== 'completed') {
    const startedAt = Date.parse(check.started_at || check.created_at || '');
    if (Number.isFinite(startedAt) && now.getTime() - startedAt >= CANDIDATE_VALIDATION_STALE_MS) {
      return 'missing';
    }
    return 'pending';
  }
  // A dispatch/API failure to *reach* the validator is an infrastructure
  // problem, not a candidate code defect. It is recorded as a `cancelled`
  // conclusion (see reconcile.mjs dispatchValidation) so it is retried on
  // the next reconciliation instead of being bisected as a real failure.
  if (check.conclusion === 'cancelled') return 'missing';
  return check.conclusion === 'success' ? 'success' : 'failure';
}

export function renderStatus({ position, candidateSha, state, detail }) {
  return [
    STATUS_MARKER,
    '## Merge train',
    '',
    `- Position: ${position}`,
    `- Candidate: \`${candidateSha || 'not built'}\``,
    `- State: \`${state}\``,
    `- Detail: ${compact(detail)}`,
    '',
    '_Managed by the trusted repository merge-train workflow._',
  ].join('\n');
}
