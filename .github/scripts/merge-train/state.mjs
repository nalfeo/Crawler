import { createHash } from 'node:crypto';

export const QUEUE_LABEL = 'merge-train';
export const BLOCKED_LABEL = 'merge-train-blocked';
export const CANDIDATE_CHECK_NAME = 'merge-train-candidate';
export const REQUIRED_CHECK_NAME = 'merge-train';
export const STATUS_MARKER = '<!-- crawler-merge-train:v1 -->';
export const DEFAULT_ADMISSION_CHECKS = ['ci', 'commit-lint', 'Security checks'];

function compact(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeMode(value) {
  const mode = compact(value || 'off').toLowerCase();
  if (!['off', 'dry-run', 'live'].includes(mode)) {
    throw new Error(`Unsupported MERGE_TRAIN_MODE: ${mode}`);
  }
  return mode;
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
  if (!Number.isInteger(slot) || slot < 1 || slot > 2) {
    throw new Error(`Invalid merge-train slot: ${slot}`);
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('Candidate fingerprint must be a SHA-256 hex digest');
  }
  return `merge-train/candidate-${slot}-${fingerprint.slice(0, 16)}`;
}

export function commitTimestamp(entry) {
  const digest = createHash('sha256')
    .update(`${entry.number}\0${compact(entry.head?.sha)}\0${compact(entry.title)}`)
    .digest();
  const seconds = 1767225600 + (digest.readUInt32BE(0) % 31536000);
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

export function trainCheckState(checkRuns) {
  const check = latestChecksByName(checkRuns).get(CANDIDATE_CHECK_NAME);
  if (!check) return 'missing';
  if (check.status !== 'completed') return 'pending';
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
