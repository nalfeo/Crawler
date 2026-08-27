import { request } from '../ci-recovery/github.mjs';

// Release sweeps are published to the `baselines` branch after every successful
// main deploy (see the "Publish to baselines branch" step in deploy.yml), so the
// newest one is always in git: it never expires like a 30-day Actions artifact
// and never needs a workflow dispatch to exist. `index.json` is regenerated from
// `by-sha/*.json` on every publish and is sorted newest-first.
export const RELEASE_BASELINE_BRANCH = 'baselines';
export const RELEASE_BASELINE_INDEX_PATH = 'index.json';

function parseRepository(repository) {
  const parts = String(repository || '').split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error('GITHUB_REPOSITORY must be in owner/repo form');
  }
  return { owner: parts[0], repo: parts[1] };
}

function toTime(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/**
 * Sort newest-first defensively rather than trusting index order, and drop
 * entries without the two fields every consumer needs (commit + payload path).
 * Everything else about the payload is deliberately not validated: the sweep
 * formulation (weapons, seed count, floor legs, frame budget) changes over
 * time and this resolver must never pin one shape.
 */
export function parseReleaseBaselineIndex(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${RELEASE_BASELINE_BRANCH}/${RELEASE_BASELINE_INDEX_PATH} is not valid JSON`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${RELEASE_BASELINE_BRANCH}/${RELEASE_BASELINE_INDEX_PATH} must be an array`);
  }
  return parsed
    .filter((entry) => entry && typeof entry.commit === 'string' && typeof entry.path === 'string')
    .slice()
    .sort(
      (left, right) =>
        toTime(right.commitDate) - toTime(left.commitDate) ||
        toTime(right.capturedAt) - toTime(left.capturedAt),
    );
}

export function selectLatestReleaseBaseline(entries) {
  return entries.length > 0 ? entries[0] : null;
}

function blobUrl({ owner, repo, path }) {
  return `https://github.com/${owner}/${repo}/blob/${RELEASE_BASELINE_BRANCH}/${path}`;
}

export async function resolveLatestReleaseBaseline({ token, repository, requestFn = request }) {
  if (!token) {
    throw new Error('Missing required environment variable: GITHUB_TOKEN');
  }
  const { owner, repo } = parseRepository(repository);
  const response = await requestFn(
    token,
    `/repos/${owner}/${repo}/contents/${RELEASE_BASELINE_INDEX_PATH}?ref=${RELEASE_BASELINE_BRANCH}`,
    { headers: { Accept: 'application/vnd.github.raw+json' } },
  );
  const data = response?.data;
  const text =
    typeof data === 'string'
      ? data
      : typeof data?.content === 'string'
        ? Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
        : null;
  if (text === null) {
    throw new Error(
      `Could not read ${RELEASE_BASELINE_BRANCH}/${RELEASE_BASELINE_INDEX_PATH} contents`,
    );
  }
  const latest = selectLatestReleaseBaseline(parseReleaseBaselineIndex(text));
  if (!latest) {
    return null;
  }
  return {
    ...latest,
    branch: RELEASE_BASELINE_BRANCH,
    payloadUrl: blobUrl({ owner, repo, path: latest.path }),
    funReportUrl:
      typeof latest.fun?.path === 'string' ? blobUrl({ owner, repo, path: latest.fun.path }) : null,
    indexUrl: blobUrl({ owner, repo, path: RELEASE_BASELINE_INDEX_PATH }),
  };
}

/**
 * Resolving the baseline is a convenience: it stamps the exact payload the
 * session must read into the issue body. A lookup failure must never stop the
 * nightly issue from being filed — the body still tells the session how to
 * resolve the newest release baseline itself.
 */
export async function resolveLatestReleaseBaselineSafely(options) {
  try {
    const baseline = await resolveLatestReleaseBaseline(options);
    return baseline
      ? { status: 'resolved', baseline }
      : { status: 'unavailable', baseline: null, reason: 'no release baseline is published yet' };
  } catch (error) {
    return {
      status: 'unavailable',
      baseline: null,
      reason: error?.message ?? String(error),
    };
  }
}

function formatLegs(legs) {
  if (!legs || typeof legs !== 'object') return null;
  const parts = Object.entries(legs)
    .filter(([, leg]) => leg && typeof leg === 'object')
    .map(([name, leg]) => `${name} ${leg.totalWins ?? '?'}/${leg.totalRuns ?? '?'}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The rendered line is descriptive provenance only — it reports whatever the
 * published baseline happens to contain and asserts no required shape.
 */
export function formatReleaseBaselineLine(baseline) {
  if (!baseline) {
    return `- Resolve it yourself from the \`${RELEASE_BASELINE_BRANCH}\` branch: read \`${RELEASE_BASELINE_INDEX_PATH}\` and take the newest entry (this issue could not resolve it at filing time).`;
  }
  const legs = formatLegs(baseline.legs);
  const details = [
    `commit \`${baseline.commit}\``,
    baseline.commitDate ? `commit date ${baseline.commitDate}` : null,
    baseline.capturedAt ? `captured ${baseline.capturedAt}` : null,
    Number.isFinite(baseline.totalRuns) ? `${baseline.totalRuns} runs` : null,
    legs ? `legs: ${legs}` : null,
  ].filter(Boolean);
  const links = [
    `payload ${baseline.payloadUrl}`,
    baseline.funReportUrl ? `fun report ${baseline.funReportUrl}` : null,
    baseline.runUrl ? `release run ${baseline.runUrl}` : null,
  ].filter(Boolean);
  return `- Newest published release baseline at filing time: ${details.join(', ')} (${links.join('; ')}). Re-resolve it before analysis in case a newer release landed since.`;
}
