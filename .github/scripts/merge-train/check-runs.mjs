const CHECKS_ACCEPT = 'application/vnd.github+json';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_TRUSTED_APP_CHECK_SUITES = 10;

async function paginateEnvelope({ request, token, path, field }) {
  const separator = path.includes('?') ? '&' : '?';
  const results = [];
  let pages = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request(token, `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`, {
      headers: { Accept: CHECKS_ACCEPT },
    });
    const values = response.data?.[field];
    if (!Array.isArray(values)) {
      throw new Error(`Expected ${field} array from ${path}`);
    }
    pages += 1;
    results.push(...values);
    if (values.length < PAGE_SIZE) return { results, pages };
  }
  throw new Error(`Pagination exceeded ${MAX_PAGES} pages for ${path}`);
}

function snapshotTimestamp(checkRun) {
  return Math.max(
    ...['completed_at', 'updated_at', 'started_at', 'created_at'].map((field) => {
      const timestamp = Date.parse(checkRun[field] || '');
      return Number.isFinite(timestamp) ? timestamp : 0;
    }),
  );
}

function preferIncomingSnapshot(existing, incoming) {
  const existingTerminal = existing.status === 'completed';
  const incomingTerminal = incoming.status === 'completed';
  if (existingTerminal !== incomingTerminal) return incomingTerminal;
  const existingTimestamp = snapshotTimestamp(existing);
  const incomingTimestamp = snapshotTimestamp(incoming);
  return incomingTimestamp >= existingTimestamp;
}

export function mergeCheckRunSnapshots(...groups) {
  const merged = new Map();
  for (const group of groups) {
    for (const checkRun of group) {
      if (!Number.isInteger(Number(checkRun.id))) {
        throw new Error('Check-run snapshots require a numeric id');
      }
      const key = String(checkRun.id);
      const existing = merged.get(key);
      if (!existing || preferIncomingSnapshot(existing, checkRun)) {
        merged.set(key, checkRun);
      }
    }
  }
  return [...merged.values()];
}

export async function listTrustedAppCheckRunsForRef({
  request,
  token,
  owner,
  repo,
  sha,
  trustedAppId,
}) {
  const encodedSha = encodeURIComponent(sha);
  const suitesResult = await paginateEnvelope({
    request,
    token,
    path:
      `/repos/${owner}/${repo}/commits/${encodedSha}/check-suites` +
      `?filter=all&app_id=${encodeURIComponent(trustedAppId)}`,
    field: 'check_suites',
  });
  if (suitesResult.results.length > MAX_TRUSTED_APP_CHECK_SUITES) {
    throw new Error(
      `Trusted App check-suite fan-out exceeded ${MAX_TRUSTED_APP_CHECK_SUITES} for ${sha}`,
    );
  }

  const checkRuns = [];
  let checkRunPages = 0;
  for (const suite of suitesResult.results) {
    const runsResult = await paginateEnvelope({
      request,
      token,
      path: `/repos/${owner}/${repo}/check-suites/${encodeURIComponent(suite.id)}/check-runs?filter=all`,
      field: 'check_runs',
    });
    checkRuns.push(...runsResult.results);
    checkRunPages += runsResult.pages;
  }
  return {
    checkRuns: mergeCheckRunSnapshots(checkRuns),
    suiteCount: suitesResult.results.length,
    suitePages: suitesResult.pages,
    checkRunPages,
  };
}

export async function resolveCandidateCheckState({
  sha,
  evidenceId,
  trustedAppId,
  now,
  loadCommitCheckRuns,
  loadTrustedAppCheckRuns,
  classify,
}) {
  const commitCheckRuns = await loadCommitCheckRuns(sha);
  const commitState = classify(commitCheckRuns, evidenceId, trustedAppId, now);
  if (commitState !== 'missing') {
    return {
      state: commitState,
      usedSuiteFallback: false,
      commitCheckRunCount: commitCheckRuns.length,
      trustedCheckRunCount: 0,
      suiteCount: 0,
      suitePages: 0,
      checkRunPages: 0,
    };
  }

  const trusted = await loadTrustedAppCheckRuns(sha);
  const merged = mergeCheckRunSnapshots(commitCheckRuns, trusted.checkRuns);
  return {
    state: classify(merged, evidenceId, trustedAppId, now),
    usedSuiteFallback: true,
    commitCheckRunCount: commitCheckRuns.length,
    trustedCheckRunCount: trusted.checkRuns.length,
    suiteCount: trusted.suiteCount,
    suitePages: trusted.suitePages,
    checkRunPages: trusted.checkRunPages,
  };
}
