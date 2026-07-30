/**
 * PR recovery loop incident library.
 *
 * Files or updates a deduplicated investigation issue when the CI recovery
 * reconciler exhausts its retry budget on a PR (same head SHA + blocker
 * fingerprint for 3+ no-progress cycles).
 *
 * Deduplication: one open issue per PR number, matched by exact title.
 * Subsequent events update the existing issue (last-seen timestamp, repetition
 * count) instead of creating duplicates.  Untrusted blocker summaries from PR
 * review threads and check output are NOT included in the issue body; only
 * controlled blocker kinds, IDs, and URLs are recorded.  The investigation
 * agent fetches the source evidence directly from those links.
 *
 * Filing or reopening the issue activates the existing
 * `issue-copilot-intake.yml` workflow (triggered on `issues: opened` and
 * `issues: reopened`).  Same-state updates do not re-trigger intake.
 */
import { createHash } from 'node:crypto';

import { LOOP_INCIDENT_FINGERPRINT_PREFIX, LOOP_INCIDENT_MARKER } from './markers.mjs';

export { LOOP_INCIDENT_MARKER, LOOP_INCIDENT_FINGERPRINT_PREFIX };
export const LOOP_INCIDENT_LABEL = 'ci-loop-incident';

/**
 * Canonical issue title for a PR loop incident.  Used for exact-match
 * deduplication: there is at most one open loop incident per PR number.
 */
export function loopIncidentTitle(prNumber) {
  return `CI recovery loop: PR #${prNumber}`;
}

/**
 * Stable fingerprint for a PR loop incident, scoped to:
 *   - `repository`   ("owner/repo") — prevents cross-repo collisions
 *   - `prNumber`     — unique per repository
 *   - `blockerFingerprint` — the normalized blocker set that caused the loop
 *
 * Head SHA is intentionally excluded so the fingerprint stays stable across
 * rebases that don't change the underlying blockers.
 */
export function loopIncidentFingerprint({ repository, prNumber, blockerFingerprint }) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        surface: 'pr-recovery',
        repository: String(repository || '').toLowerCase(),
        prNumber: Number.parseInt(String(prNumber), 10),
        blockerFingerprint: String(blockerFingerprint || ''),
      }),
    )
    .digest('hex');
}

/**
 * Build the managed issue body.
 *
 * Only controlled data is embedded in the body: blocker kinds, IDs, and URLs.
 * Untrusted blocker summaries from PR review threads and CI check output are
 * deliberately excluded — the investigation agent fetches source evidence
 * directly from the linked URLs.
 */
export function buildLoopIncidentBody({
  prNumber,
  headSha,
  blockerFingerprint: fp,
  blockers,
  attempt,
  firstSeenAt,
  lastSeenAt,
  repetitionCount,
  workflowRunUrl,
  prHtmlUrl,
  repository,
}) {
  const fingerprint = loopIncidentFingerprint({ repository, prNumber, blockerFingerprint: fp });

  // Only include controlled data: kind, id, and URL.  Summaries sourced from
  // PR review threads or check output are untrusted and must never be embedded
  // in the issue body, even inside blockquotes, because the investigation agent
  // reads the entire issue without markdown-rendering context.
  const blockerLines =
    (blockers || []).length === 0
      ? ['_No blockers recorded._']
      : (blockers || []).map((blocker, index) => {
          const safeKind = String(blocker.kind || 'unknown').replace(/[`]/g, "'");
          const safeId = String(blocker.id || '').replace(/[`]/g, "'");
          // Only embed the URL if it is a valid https:// link.  Parse with the
          // URL constructor to reject malformed values and non-https schemes.
          let safeUrl = null;
          try {
            const parsed = new URL(String(blocker.url || ''));
            if (parsed.protocol === 'https:') safeUrl = parsed.href;
          } catch {
            // Not a valid URL — omit it.
          }
          return `${index + 1}. **${safeKind}** \`${safeId}\`${safeUrl ? `  \n   ${safeUrl}` : ''}`;
        });

  return [
    LOOP_INCIDENT_MARKER,
    `${LOOP_INCIDENT_FINGERPRINT_PREFIX}${fingerprint} -->`,
    '',
    `The automated CI recovery pipeline made no progress on **PR #${prNumber}** after repeated attempts. An investigation agent has been assigned to diagnose the root cause.`,
    '',
    '## Incident details',
    '',
    `- **PR:** [#${prNumber}](${prHtmlUrl || `https://github.com/${repository}/pull/${prNumber}`})`,
    `- **Affected head:** \`${String(headSha || 'unknown')}\``,
    `- **First seen:** ${firstSeenAt}`,
    `- **Last seen:** ${lastSeenAt}`,
    `- **Repetition count:** ${repetitionCount}`,
    `- **Recovery attempts exhausted:** ${attempt}`,
    `- **Incident fingerprint:** \`${fingerprint}\``,
    ...(workflowRunUrl ? [`- **Last workflow run:** ${workflowRunUrl}`] : []),
    '',
    '## Blockers at time of detection',
    '',
    '_The entries below list only blocker kinds, IDs, and URLs (controlled data)._',
    '_Fetch the linked source evidence directly — untrusted summaries are excluded from this issue._',
    '',
    ...blockerLines,
    '',
    '## Investigation prompt',
    '',
    `@copilot Please investigate why the CI recovery automation failed to converge on PR #${prNumber}.`,
    '',
    '**Fetch the linked blocker URLs above for the full evidence before investigating.**',
    '',
    'Specifically investigate:',
    `1. Why did recovery make no progress after ${attempt} attempts on PR #${prNumber}?`,
    '2. Is there a deterministic defect in the marker parser, permission grant, thread-resolution path, or mutation sequence?',
    '3. What is the smallest correct fix, and does it need a regression test?',
    '',
    "Implement the fix on a branch from `main`, run the repository's required verification, open a non-draft PR, and arm squash auto-merge.",
    'Do not weaken any gate or explicit requirement.',
  ].join('\n');
}

function parseExistingLoopIncidentIssue(existing, fallbackLastSeenAt) {
  const bodyStr = String(existing?.body || '');
  const firstSeenMatch = bodyStr.match(/\*\*First seen:\*\* ([^\n]+)/);
  const firstSeenAt = firstSeenMatch ? firstSeenMatch[1].trim() : fallbackLastSeenAt;
  const repMatch = bodyStr.match(/\*\*Repetition count:\*\* (\d+)/);
  const repetitionCount = repMatch ? Number.parseInt(repMatch[1], 10) + 1 : 2;
  return { firstSeenAt, repetitionCount };
}

function isOpenIssue(issue) {
  const state = String(issue?.state || '').toLowerCase();
  return state === '' || state === 'open';
}

/**
 * File or update a deduplicated PR loop incident issue.
 *
 * @param {object} opts
 * @param {Function} opts.request   - github.mjs `request` helper
 * @param {Function} opts.paginate  - github.mjs `paginate` helper
 * @param {string}  opts.token      - PAT with issues:write
 * @param {string}  opts.owner
 * @param {string}  opts.repo
 * @param {number}  opts.prNumber
 * @param {string}  opts.headSha
 * @param {string}  opts.blockerFingerprint
 * @param {Array}   opts.blockers
 * @param {number}  opts.attempt    - exhausted attempt count from reconciler state
 * @param {string|null} opts.workflowRunUrl - optional URL of the detecting workflow run
 * @param {Date}    [opts.now]
 * @returns {Promise<{action: 'created'|'updated'|'reopened', issueNumber: number}>}
 */
export async function fileLoopIncident({
  request,
  paginate,
  token,
  owner,
  repo,
  prNumber,
  headSha,
  blockerFingerprint: fp,
  blockers,
  attempt,
  workflowRunUrl,
  now = new Date(),
}) {
  const repository = `${owner}/${repo}`;
  const title = loopIncidentTitle(prNumber);
  const prHtmlUrl = `https://github.com/${repository}/pull/${prNumber}`;
  const lastSeenAt = now.toISOString();

  // Ensure the label exists (idempotent — 422 Unprocessable Entity means it
  // already exists, which is the expected steady-state).
  try {
    await request(token, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: {
        name: LOOP_INCIDENT_LABEL,
        color: 'd93f0b',
        description: 'Deduplicated PR recovery loop incident',
      },
    });
  } catch (err) {
    if (err.status !== 422) throw err;
  }

  // Search for an existing incident with this exact title (scoped to the label
  // so the list stays small even in active repositories). Prefer an already-open
  // issue; otherwise reuse the most recently updated closed issue so repeated
  // loops on the same PR preserve their first-seen timestamp and repetition
  // count instead of creating a fresh duplicate issue.
  const openIssues = await paginate(
    token,
    `/repos/${owner}/${repo}/issues?state=all&labels=${encodeURIComponent(LOOP_INCIDENT_LABEL)}`,
  );
  const matchingIssues = openIssues.filter(
    (issue) =>
      !issue.pull_request && String(issue.title).toLowerCase() === title.toLowerCase(),
  );
  const existingOpen = matchingIssues.find((issue) => isOpenIssue(issue));
  const existingClosed = [...matchingIssues]
    .filter((issue) => !isOpenIssue(issue))
    .sort((left, right) => {
      const leftTime = Date.parse(left.updated_at || left.created_at || 0);
      const rightTime = Date.parse(right.updated_at || right.created_at || 0);
      return rightTime - leftTime;
    })[0];
  const existing = existingOpen || existingClosed;

  if (existing) {
    const { firstSeenAt, repetitionCount } = parseExistingLoopIncidentIssue(existing, lastSeenAt);

    const body = buildLoopIncidentBody({
      prNumber,
      headSha,
      blockerFingerprint: fp,
      blockers,
      attempt,
      firstSeenAt,
      lastSeenAt,
      repetitionCount,
      workflowRunUrl,
      prHtmlUrl,
      repository,
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

  // No existing open incident — create one.  GitHub's `issues: opened` event
  // triggers `issue-copilot-intake.yml` automatically, which assigns the
  // investigation agent exactly once.
  const body = buildLoopIncidentBody({
    prNumber,
    headSha,
    blockerFingerprint: fp,
    blockers,
    attempt,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    repetitionCount: 1,
    workflowRunUrl,
    prHtmlUrl,
    repository,
  });

  const issue = (
    await request(token, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: { title, body, labels: [LOOP_INCIDENT_LABEL] },
    })
  ).data;

  return { action: 'created', issueNumber: issue.number };
}

/**
 * Close an open loop-incident issue for a PR if one exists.
 *
 * Called by the reconciler when it reaches a converged state (ARM_AUTO_MERGE /
 * QUEUE_MERGE_TRAIN) for a PR that previously triggered a loop incident.
 * Idempotent: if no open incident exists this is a no-op.
 *
 * @param {object} opts
 * @param {Function} opts.request   - github.mjs `request` helper
 * @param {Function} opts.paginate  - github.mjs `paginate` helper
 * @param {string}  opts.token      - PAT with issues:write
 * @param {string}  opts.owner
 * @param {string}  opts.repo
 * @param {number}  opts.prNumber
 * @returns {Promise<{action: 'closed', issueNumber: number}|{action: 'not-found'}>}
 */
export async function closeLoopIncident({ request, paginate, token, owner, repo, prNumber }) {
  const title = loopIncidentTitle(prNumber);

  const openIssues = await paginate(
    token,
    `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(LOOP_INCIDENT_LABEL)}`,
  );
  const existing = openIssues.find(
    (issue) => !issue.pull_request && String(issue.title).toLowerCase() === title.toLowerCase(),
  );

  if (!existing) {
    return { action: 'not-found' };
  }

  await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
    method: 'PATCH',
    body: { state: 'closed', state_reason: 'completed' },
  });

  return { action: 'closed', issueNumber: existing.number };
}
