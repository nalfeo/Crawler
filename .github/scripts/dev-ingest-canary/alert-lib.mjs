/**
 * Dev-build ingest canary alert library.
 *
 * Files or updates a single deduplicated alert issue when the automated
 * `dev-ingest-lifecycle.yml` canary check discovers that the live
 * `crawler-dev-ingest` Function can no longer file GitHub issues (for
 * example: `CRAWLER_CI_PAT` was revoked or expired). Closes the same issue
 * automatically once a subsequent canary run succeeds again.
 *
 * Deduplication: exactly one open alert issue at a time, matched by exact
 * title. Repeated failures update the existing issue (last-seen timestamp,
 * repetition count) instead of creating duplicates or leaving permanent
 * issue noise — mirrors `ci-recovery/loop-incident-lib.mjs`'s pattern.
 *
 * This uses the workflow's own `GITHUB_TOKEN`, never `CRAWLER_CI_PAT` — the
 * whole point of the alert is to still fire when that credential is the
 * thing that broke.
 */
export const CANARY_ALERT_LABEL = 'dev-ingest-canary-alert';

/** Canonical, stable title used for exact-match deduplication. */
export function canaryAlertTitle() {
  return 'Dev-build ingest canary: GitHub issue-filing check is failing';
}

function isOpenIssue(issue) {
  const state = String(issue?.state || '').toLowerCase();
  return state === '' || state === 'open';
}

function parseExistingAlertIssue(existing, fallbackLastSeenAt) {
  const bodyStr = String(existing?.body || '');
  const firstSeenMatch = bodyStr.match(/\*\*First seen:\*\* ([^\n]+)/);
  const firstSeenAt = firstSeenMatch ? firstSeenMatch[1].trim() : fallbackLastSeenAt;
  const repMatch = bodyStr.match(/\*\*Repetition count:\*\* (\d+)/);
  const repetitionCount = repMatch ? Number.parseInt(repMatch[1], 10) + 1 : 2;
  return { firstSeenAt, repetitionCount };
}

/** Build the managed alert issue body. Only controlled data is embedded. */
export function buildCanaryAlertBody({
  errorMessage,
  firstSeenAt,
  lastSeenAt,
  repetitionCount,
  workflowRunUrl,
}) {
  const safeError = String(errorMessage || 'unknown error').replace(/`/g, "'");
  return [
    '<!-- dev-ingest-canary-alert:do-not-edit -->',
    '',
    'The automated canary check in `.github/workflows/dev-ingest-lifecycle.yml` could',
    "not file a GitHub issue through the live `crawler-dev-ingest` Function's",
    '`/runs` endpoint (`file_issue: true`). This almost always means the',
    '`CRAWLER_CI_PAT` Function App setting has been revoked, expired, or was lost',
    'on a redeploy that omitted `githubCiPat` — the same failure mode',
    '[nalfeo/Crawler#4033](https://github.com/nalfeo/Crawler/issues/4033) reported',
    'before that parameter became required.',
    '',
    '## Details',
    '',
    `- **First seen:** ${firstSeenAt}`,
    `- **Last seen:** ${lastSeenAt}`,
    `- **Repetition count:** ${repetitionCount}`,
    `- **Last error:** \`${safeError}\``,
    ...(workflowRunUrl ? [`- **Failing workflow run:** ${workflowRunUrl}`] : []),
    '',
    '## Remediation',
    '',
    '1. Confirm the `CRAWLER_CI_PAT` GitHub Actions secret is still a valid PAT',
    '   scoped to `repo` (issues:write) on `nalfeo/Crawler`.',
    '2. Rotate the live Function App setting out-of-band (see `infra/README.md`',
    '   → "Dev-build ingest Function" → rotation command), or redeploy',
    '   `infra/dev-build-ingest.bicep` with `githubCiPat=$env:CRAWLER_CI_PAT`.',
    '3. Re-run this workflow manually (`workflow_dispatch`) to confirm the fix —',
    '   this issue closes itself automatically on the next successful canary run.',
    '',
    'This issue is machine-managed: do not close it manually, the canary will',
    'reopen it on its own if the credential is still broken.',
  ].join('\n');
}

/**
 * File or update the single deduplicated canary alert issue.
 *
 * @param {object} opts
 * @param {Function} opts.request  - github.mjs `request` helper
 * @param {Function} opts.paginate - github.mjs `paginate` helper
 * @param {string}  opts.token     - token with issues:write (workflow GITHUB_TOKEN)
 * @param {string}  opts.owner
 * @param {string}  opts.repo
 * @param {string}  opts.errorMessage
 * @param {string|null} [opts.workflowRunUrl]
 * @param {Date}    [opts.now]
 * @returns {Promise<{action: 'created'|'updated'|'reopened', issueNumber: number}>}
 */
export async function fileOrUpdateCanaryAlert({
  request,
  paginate,
  token,
  owner,
  repo,
  errorMessage,
  workflowRunUrl = null,
  now = new Date(),
}) {
  const title = canaryAlertTitle();
  const lastSeenAt = now.toISOString();

  // Ensure the label exists (idempotent — 422 means it already exists).
  try {
    await request(token, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: {
        name: CANARY_ALERT_LABEL,
        color: 'b60205',
        description:
          'Dev-build ingest live canary detected a broken GitHub issue-filing credential',
      },
    });
  } catch (err) {
    if (err.status !== 422) throw err;
  }

  const candidates = await paginate(
    token,
    `/repos/${owner}/${repo}/issues?state=all&labels=${encodeURIComponent(CANARY_ALERT_LABEL)}`,
  );
  const matching = candidates.filter(
    (issue) => !issue.pull_request && String(issue.title).toLowerCase() === title.toLowerCase(),
  );
  const existingOpen = matching.find((issue) => isOpenIssue(issue));
  const existingClosed = [...matching]
    .filter((issue) => !isOpenIssue(issue))
    .sort((left, right) => {
      const leftTime = Date.parse(left.updated_at || left.created_at || 0);
      const rightTime = Date.parse(right.updated_at || right.created_at || 0);
      return rightTime - leftTime;
    })[0];
  const existing = existingOpen || existingClosed;

  if (existing) {
    const { firstSeenAt, repetitionCount } = parseExistingAlertIssue(existing, lastSeenAt);
    const body = buildCanaryAlertBody({
      errorMessage,
      firstSeenAt,
      lastSeenAt,
      repetitionCount,
      workflowRunUrl,
    });
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: {
        body,
        ...(existingOpen ? {} : { state: 'open' }),
      },
    });
    return { action: existingOpen ? 'updated' : 'reopened', issueNumber: existing.number };
  }

  const body = buildCanaryAlertBody({
    errorMessage,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    repetitionCount: 1,
    workflowRunUrl,
  });
  const issue = (
    await request(token, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: { title, body, labels: [CANARY_ALERT_LABEL] },
    })
  ).data;
  return { action: 'created', issueNumber: issue.number };
}

/**
 * Close the open canary alert issue, if one exists. Idempotent no-op when
 * there is nothing to close (the steady-state, healthy-credential case).
 *
 * @param {object} opts
 * @param {Function} opts.request
 * @param {Function} opts.paginate
 * @param {string}  opts.token
 * @param {string}  opts.owner
 * @param {string}  opts.repo
 * @returns {Promise<{action: 'closed', issueNumber: number}|{action: 'not-found'}>}
 */
export async function closeCanaryAlert({ request, paginate, token, owner, repo }) {
  const title = canaryAlertTitle();
  const openIssues = await paginate(
    token,
    `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(CANARY_ALERT_LABEL)}`,
  );
  const existing = openIssues.find(
    (issue) => !issue.pull_request && String(issue.title).toLowerCase() === title.toLowerCase(),
  );
  if (!existing) return { action: 'not-found' };

  await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
    method: 'PATCH',
    body: {
      state: 'closed',
      state_reason: 'completed',
    },
  });
  await request(token, `/repos/${owner}/${repo}/issues/${existing.number}/comments`, {
    method: 'POST',
    body: { body: 'Canary succeeded again — closing automatically.' },
  });
  return { action: 'closed', issueNumber: existing.number };
}
