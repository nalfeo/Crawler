/**
 * Stale-session harvest liveness alarm.
 *
 * The CI recovery reconciler is the repository's stale-session harvester: it
 * expires shepherd leases, releases stalled automation ownership, reconciles
 * review threads, and applies the `merge-train` admission label. Every other
 * piece of delivery automation depends on it running.
 *
 * The pre-existing liveness machinery could not detect the harvester being
 * *dead*, only individual PRs being stuck:
 *
 *   - `loop-incident-lib.mjs` files a per-PR incident, but it runs INSIDE the
 *     reconciler and authenticates with `CRAWLER_CI_PAT`. When the PAT budget is
 *     exhausted the reconciler cannot run, so it cannot file the incident that
 *     would report that it cannot run.
 *   - `ci-liveness-sweep.yml` re-dispatches the reconciler every 10 minutes, but
 *     fire-and-forget: it never checks whether any dispatch succeeded.
 *
 * Incident 2026-07-30: `CRAWLER_CI_PAT` is a classic user PAT, so its 5,000
 * req/hr core budget is shared across every token owned by that user. It hit
 * zero and every reconciler run 403'd for ~7 hours. Leases never expired,
 * threads were never reconciled, the `merge-train` label was never applied, the
 * train reconciled to empty, and nothing merged. The sweep kept firing into the
 * void the entire time. The only alarm that fired came from the merge train's
 * own empty-train incident — the harvester itself was silent.
 *
 * This module closes that hole by checking harvester liveness from OUTSIDE the
 * harvester. It is driven by `ci-liveness-sweep.yml` using the workflow's
 * `GITHUB_TOKEN`, whose rate-limit budget is per-repository-installation and
 * therefore independent of the owner PAT bucket. That independence is the whole
 * point: the alarm must survive the exact failure it exists to report.
 */

import { DECISION_LOG_MARKER } from './decision-log.mjs';
import { DISPATCH_ACTION } from './dispatch-table.mjs';

export const HARVEST_INCIDENT_LABEL = 'ci-incident';
export const HARVEST_INCIDENT_TITLE = 'CI incident: stale-session harvest not completing';
export const HARVEST_INCIDENT_MARKER = '<!-- crawler:ci-harvest-liveness -->';
export const DISPATCH_LIVENESS_INCIDENT_LABEL = HARVEST_INCIDENT_LABEL;
export const DISPATCH_LIVENESS_INCIDENT_TITLE = 'CI incident: CI recovery dispatch liveness gap';
export const DISPATCH_LIVENESS_INCIDENT_MARKER = '<!-- crawler:ci-dispatch-liveness -->';

/** Minutes without a successful harvest run before the alarm fires. */
export const DEFAULT_HARVEST_THRESHOLD_MINUTES = 60;
export const DEFAULT_DISPATCH_LIVENESS_WINDOW_HOURS = 8;
export const DEFAULT_PR_DISPATCH_GAP_HOURS = 4;

function parseRunTimestamp(run) {
  const at = Date.parse(run?.updated_at || run?.run_started_at || run?.created_at || '');
  return Number.isFinite(at) ? at : null;
}

export function isReconcileHarvestRun(run) {
  return String(run?.display_title || '')
    .toLowerCase()
    .includes('ci recovery (reconcile)');
}

/**
 * Collect reconcile harvest runs and paginate until the sampled window reaches
 * the threshold age.
 *
 * @param {{
 *   listWorkflowRuns: (params: {
 *     owner: string,
 *     repo: string,
 *     workflow_id: string,
 *     event: string,
 *     per_page: number,
 *     page: number,
 *   }) => Promise<{data?: {workflow_runs?: Array<any>}}>,
 *   owner: string,
 *   repo: string,
 *   workflowId?: string,
 *   thresholdMinutes?: number,
 *   now?: Date,
 *   perPage?: number,
 * }} opts
 */
export async function collectRecentReconcileHarvestRuns({
  listWorkflowRuns,
  owner,
  repo,
  workflowId = 'ci-recovery.yml',
  thresholdMinutes = DEFAULT_HARVEST_THRESHOLD_MINUTES,
  now = new Date(),
  perPage = 100,
}) {
  const cutoffMs = now.getTime() - thresholdMinutes * 60000;
  const collected = [];
  for (let page = 1; ; page += 1) {
    const response = await listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowId,
      event: 'workflow_dispatch',
      per_page: perPage,
      page,
    });
    const runs = response?.data?.workflow_runs || [];
    collected.push(...runs.filter((run) => isReconcileHarvestRun(run)));

    const oldestRunAt = runs.reduce((oldest, run) => {
      const at = parseRunTimestamp(run);
      if (at === null) return oldest;
      return oldest === null || at < oldest ? at : oldest;
    }, null);
    if (runs.length === 0) break;
    if (oldestRunAt !== null && oldestRunAt <= cutoffMs) break;
    if (runs.length < perPage) break;
  }
  return collected;
}

/**
 * Reduce a list of workflow runs to the liveness facts we care about.
 *
 * `success` is the right health signal even though most reconciler runs exit
 * having done nothing (`skip pr=#N reason=duplicate-fingerprint`): a successful
 * exit proves the harvester reached the API and completed its pass. A run that
 * is still in progress proves nothing yet and is ignored.
 *
 * @param {Array<{status?: string, conclusion?: string, updated_at?: string,
 *   run_started_at?: string, created_at?: string, html_url?: string}>} runs
 * @param {Date} now
 */
export function summarizeHarvestRuns(runs, now = new Date()) {
  const completed = (runs || [])
    .filter((run) => String(run?.status || '').toLowerCase() === 'completed')
    .map((run) => ({
      conclusion: String(run?.conclusion || '').toLowerCase(),
      at: parseRunTimestamp(run),
      url: run?.html_url || null,
    }))
    .filter((run) => Number.isFinite(run.at))
    .sort((left, right) => right.at - left.at);

  const lastSuccess = completed.find((run) => run.conclusion === 'success') || null;

  // Count failures newer than the last success. `cancelled` counts: the
  // reconciler's `queue: single` concurrency cancels post-merge passes, which
  // was an aggravator in the 2026-07-30 stoppage.
  let consecutiveFailures = 0;
  for (const run of completed) {
    if (run.conclusion === 'success') break;
    if (['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(run.conclusion)) {
      consecutiveFailures += 1;
    }
  }

  const minutesSinceSuccess = lastSuccess
    ? Math.max(0, Math.floor((now.getTime() - lastSuccess.at) / 60000))
    : null;

  return {
    completedCount: completed.length,
    lastSuccessAt: lastSuccess ? new Date(lastSuccess.at).toISOString() : null,
    lastSuccessUrl: lastSuccess ? lastSuccess.url : null,
    minutesSinceSuccess,
    consecutiveFailures,
    lastFailureUrl: completed.find((run) => run.conclusion !== 'success')?.url || null,
  };
}

export function parseDecisionRecords(logText) {
  return String(logText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${DECISION_LOG_MARKER} `))
    .map((line) => line.slice(DECISION_LOG_MARKER.length + 1))
    .map((json) => {
      try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function summarizeDispatchLiveness({
  decisions,
  openBlockedPulls,
  now = new Date(),
  windowHours = DEFAULT_DISPATCH_LIVENESS_WINDOW_HOURS,
  perPrGapHours = DEFAULT_PR_DISPATCH_GAP_HOURS,
}) {
  const windowMs = windowHours * 60 * 60 * 1000;
  const perPrGapMs = perPrGapHours * 60 * 60 * 1000;
  const windowStartMs = now.getTime() - windowMs;
  const inWindow = (decisions || []).filter((record) => {
    const at = Date.parse(String(record?.ts || ''));
    return Number.isFinite(at) && at >= windowStartMs;
  });

  const dispatches = inWindow.filter(
    (record) =>
      record?.stage === 'terminal' && String(record?.action || '') === DISPATCH_ACTION.DISPATCH_COPILOT,
  );
  const nonDispatchHistogram = new Map();
  for (const record of inWindow) {
    const action = String(record?.action || '');
    if (!action || action === DISPATCH_ACTION.DISPATCH_COPILOT) continue;
    nonDispatchHistogram.set(action, (nonDispatchHistogram.get(action) || 0) + 1);
  }

  const openBlocked = (openBlockedPulls || []).filter((pull) => Number.isFinite(Number(pull?.number)));
  const staleBlockedPulls = [];
  const neverSummonedBlockedPulls = [];
  for (const pull of openBlocked) {
    const number = Number(pull.number);
    const dispatchTimestamps = dispatches
      .filter((record) => Number(record?.pr) === number)
      .map((record) => Date.parse(String(record.ts || '')))
      .filter(Number.isFinite)
      .sort((left, right) => right - left);
    const lastDispatchAt = dispatchTimestamps[0] ?? null;
    const fallbackAt = Date.parse(String(pull.blocked_since || pull.updated_at || pull.created_at || ''));
    if (lastDispatchAt === null && Number.isFinite(fallbackAt) && now.getTime() - fallbackAt >= perPrGapMs) {
      neverSummonedBlockedPulls.push(pull);
      staleBlockedPulls.push(pull);
      continue;
    }
    if (lastDispatchAt !== null && now.getTime() - lastDispatchAt >= perPrGapMs) {
      staleBlockedPulls.push(pull);
    }
  }

  const noDispatchForBlockedBacklog = openBlocked.length > 0 && dispatches.length === 0;
  const stalledPerPrGap = staleBlockedPulls.length > 0;
  const stalled = noDispatchForBlockedBacklog || stalledPerPrGap;
  const reason = noDispatchForBlockedBacklog
    ? stalledPerPrGap
      ? 'no-dispatches-and-per-pr-gap'
      : 'no-dispatches-for-blocked-backlog'
    : stalledPerPrGap
      ? 'per-pr-dispatch-gap-exceeded'
      : 'healthy';

  return {
    stalled,
    reason,
    windowHours,
    perPrGapHours,
    openBlockedCount: openBlocked.length,
    dispatchCount: dispatches.length,
    staleBlockedPulls,
    neverSummonedBlockedPulls,
    decisionCountInWindow: inWindow.length,
    nonDispatchHistogram: [...nonDispatchHistogram.entries()].sort((left, right) => right[1] - left[1]),
  };
}

/**
 * Decide whether the harvester is stalled.
 *
 * Requires open backlog before alarming, mirroring the merge train's
 * empty-train incident: a quiet repository with nothing to harvest is not an
 * incident, and a false alarm every 10 minutes would train everyone to ignore
 * the real one.
 *
 * @param {{summary: ReturnType<typeof summarizeHarvestRuns>, backlogCount: number,
 *   thresholdMinutes?: number}} opts
 * @returns {{stalled: boolean, reason: string}}
 */
export function evaluateHarvestLiveness({
  summary,
  backlogCount,
  thresholdMinutes = DEFAULT_HARVEST_THRESHOLD_MINUTES,
}) {
  if (!(backlogCount > 0)) {
    return { stalled: false, reason: 'no-open-backlog' };
  }
  if (summary.completedCount === 0) {
    // No completed runs at all in the sampled window. The sweep dispatches every
    // 10 minutes, so an empty window means dispatches are not producing runs.
    return { stalled: true, reason: 'no-completed-runs-in-window' };
  }
  if (summary.lastSuccessAt === null) {
    return { stalled: true, reason: 'no-successful-run-in-window' };
  }
  if (summary.minutesSinceSuccess >= thresholdMinutes) {
    return { stalled: true, reason: 'last-success-older-than-threshold' };
  }
  return { stalled: false, reason: 'healthy' };
}

/**
 * Render the managed incident body.
 *
 * Deliberately names the shared-user-PAT bucket as the first thing to check:
 * that was the 2026-07-30 root cause, it is invisible in `gh api rate_limit`
 * (which reported budget remaining while live calls returned 403), and it is
 * only observable in raw response headers.
 */
export function buildHarvestIncidentBody({
  now = new Date(),
  summary,
  backlogCount,
  thresholdMinutes = DEFAULT_HARVEST_THRESHOLD_MINUTES,
  reason,
  workflowRunUrl = null,
  repository = null,
}) {
  const lastSuccess = summary.lastSuccessAt
    ? `${summary.lastSuccessAt} (${summary.minutesSinceSuccess}m ago)`
    : 'none in sampled window';

  return [
    HARVEST_INCIDENT_MARKER,
    '',
    'The stale-session harvest (CI recovery reconciler) has not completed a successful run recently while PRs are open and waiting on it.',
    '',
    'While the harvester is down, shepherd leases never expire, stalled automation ownership is never released, review threads are never reconciled, and the `merge-train` admission label is never applied — so the merge train reconciles to empty and nothing merges.',
    '',
    '## Detection',
    '',
    `- Observed: ${now.toISOString()}`,
    `- Reason: \`${reason}\``,
    `- Last successful harvest: ${lastSuccess}`,
    `- Threshold: ${thresholdMinutes}m`,
    `- Completed runs in sampled window: ${summary.completedCount}`,
    `- Failed/cancelled runs since last success: ${summary.consecutiveFailures}`,
    `- Open PRs waiting: ${backlogCount}`,
    ...(summary.lastFailureUrl ? [`- Most recent non-success run: ${summary.lastFailureUrl}`] : []),
    ...(workflowRunUrl ? [`- Detected by: ${workflowRunUrl}`] : []),
    '',
    '## First thing to check: the shared user-PAT rate-limit bucket',
    '',
    '`CRAWLER_CI_PAT` is a classic user PAT. GitHub enforces its 5,000 req/hr core budget at the *user* level, shared across every token that user owns, and returns `403 API rate limit exceeded for user ID <id>` on every REST call once exhausted.',
    '',
    '**Do not trust `gh api rate_limit`** — during the 2026-07-30 stoppage it reported ~4,400 core requests remaining while live calls returned `X-RateLimit-Remaining: 0`. Confirm with raw response headers instead:',
    '',
    '```bash',
    `REPOSITORY="${repository || '<owner>/<repo>'}"`,
    'curl -s -D - -o /dev/null \\',
    '  -H "Authorization: ******" \\',
    '  "https://api.github.com/repos/${REPOSITORY}/pulls?per_page=1" | grep -i x-ratelimit',
    '```',
    '',
    'GraphQL has a separate budget and usually still works when REST is exhausted — `gh api graphql` is the fallback for triage and for manual `resolveReviewThread` / `addLabelsToLabelable` calls.',
    '',
    '## Other causes to rule out',
    '',
    '1. Reconciler runs parked in `action_required` (bot-pushed commits do not schedule workflows).',
    '2. `queue: single` concurrency cancelling every pass before it completes.',
    '3. A crash or timeout in `.github/scripts/ci-recovery/reconcile.mjs` — read the linked non-success run.',
    '4. A revoked/expired `CRAWLER_CI_PAT`.',
    '',
    'This issue is managed by `.github/scripts/ci-recovery/harvest-liveness.mjs` and auto-closes once a harvest run succeeds again.',
  ].join('\n');
}

export function buildDispatchLivenessIncidentBody({
  now = new Date(),
  summary,
  workflowRunUrl = null,
  repository = null,
}) {
  const histogramLines =
    summary.nonDispatchHistogram.length === 0
      ? ['_No non-dispatch decisions were recorded in the sampled window._']
      : summary.nonDispatchHistogram.map(([action, count]) => `- \`${action}\`: ${count}`);
  const neverSummonedLines =
    summary.neverSummonedBlockedPulls.length === 0
      ? ['_None._']
      : summary.neverSummonedBlockedPulls.map((pull) => {
          const url = pull.html_url || `https://github.com/${repository}/pull/${pull.number}`;
          return `- [#${pull.number}](${url})`;
        });

  return [
    DISPATCH_LIVENESS_INCIDENT_MARKER,
    '',
    'CI recovery decision logs show that `@copilot` dispatches are not happening for blocked open PRs.',
    '',
    '## Detection',
    '',
    `- Observed: ${now.toISOString()}`,
    `- Reason: \`${summary.reason}\``,
    `- Decision window: ${summary.windowHours}h`,
    `- Per-PR dispatch gap threshold: ${summary.perPrGapHours}h`,
    `- Open blocked PRs in scope: ${summary.openBlockedCount}`,
    `- Dispatch-class decisions in window: ${summary.dispatchCount}`,
    `- Decision records in window: ${summary.decisionCountInWindow}`,
    ...(workflowRunUrl ? [`- Detected by: ${workflowRunUrl}`] : []),
    '',
    '## Skip/no-op histogram',
    '',
    ...histogramLines,
    '',
    '## Blocked PRs with no dispatch in threshold window',
    '',
    ...neverSummonedLines,
    '',
    '@copilot Diagnose why CI recovery is not summoning for blocked PRs, implement the smallest correct fix from `main`, run required verification, open a non-draft PR, and arm squash auto-merge. Do not weaken a gate or explicit requirement.',
  ].join('\n');
}

function isOpenIssue(issue) {
  const state = String(issue?.state || '').toLowerCase();
  return state === '' || state === 'open';
}

function findManagedIncident(issues) {
  return issues.find(
    (issue) =>
      !issue.pull_request &&
      String(issue.title) === HARVEST_INCIDENT_TITLE &&
      String(issue.body || '').includes(HARVEST_INCIDENT_MARKER),
  );
}

/**
 * Open, update, or close the managed harvest incident.
 *
 * Idempotent and safe to call on every 10-minute sweep.
 *
 * @returns {Promise<{action: 'created'|'updated'|'closed'|'noop', issueNumber?: number}>}
 */
export async function reconcileHarvestIncident({
  request,
  paginate,
  token,
  owner,
  repo,
  verdict,
  summary,
  backlogCount,
  thresholdMinutes = DEFAULT_HARVEST_THRESHOLD_MINUTES,
  workflowRunUrl = null,
  now = new Date(),
}) {
  const issues = await paginate(
    token,
    `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(DISPATCH_LIVENESS_INCIDENT_LABEL)}&per_page=100`,
  );
  const existing = findManagedIncident(issues);

  if (!verdict.stalled) {
    if (!existing) return { action: 'noop' };
    const resolved = `${String(existing.body || '').trim()}\n\n- Auto-resolved: ${now.toISOString()} (${verdict.reason})`;
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'completed', body: resolved },
    });
    return { action: 'closed', issueNumber: existing.number };
  }

  const body = buildHarvestIncidentBody({
    now,
    summary,
    backlogCount,
    thresholdMinutes,
    reason: verdict.reason,
    workflowRunUrl,
    repository: `${owner}/${repo}`,
  });

  if (existing) {
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: { body },
    });
    return { action: 'updated', issueNumber: existing.number };
  }

  const created = await request(token, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: { title: HARVEST_INCIDENT_TITLE, labels: [HARVEST_INCIDENT_LABEL], body },
  });
  return { action: 'created', issueNumber: created.data.number };
}

function findManagedDispatchLivenessIncident(issues) {
  return issues.find(
    (issue) =>
      !issue.pull_request &&
      String(issue.title) === DISPATCH_LIVENESS_INCIDENT_TITLE &&
      String(issue.body || '').includes(DISPATCH_LIVENESS_INCIDENT_MARKER),
  );
}

export async function reconcileDispatchLivenessIncident({
  request,
  paginate,
  token,
  owner,
  repo,
  summary,
  workflowRunUrl = null,
  now = new Date(),
}) {
  const issues = await paginate(
    token,
    `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(HARVEST_INCIDENT_LABEL)}&per_page=100`,
  );
  const existing = findManagedDispatchLivenessIncident(issues);

  if (!summary.stalled) {
    if (!existing) return { action: 'noop' };
    const resolved = `${String(existing.body || '').trim()}\n\n- Auto-resolved: ${now.toISOString()} (healthy)`;
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'completed', body: resolved },
    });
    return { action: 'closed', issueNumber: existing.number };
  }

  const body = buildDispatchLivenessIncidentBody({
    now,
    summary,
    workflowRunUrl,
    repository: `${owner}/${repo}`,
  });
  if (existing) {
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: { body },
    });
    return { action: 'updated', issueNumber: existing.number };
  }

  const created = await request(token, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: {
      title: DISPATCH_LIVENESS_INCIDENT_TITLE,
      labels: [DISPATCH_LIVENESS_INCIDENT_LABEL],
      body,
    },
  });
  return { action: 'created', issueNumber: created.data.number };
}
