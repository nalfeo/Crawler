/**
 * CLI entrypoint: run a single live canary check against the deployed
 * `crawler-dev-ingest` Function's anonymous `/runs` endpoint with
 * `file_issue: true`, verify a GitHub issue was actually filed, label and
 * close it immediately (avoids permanent issue noise), and manage a single
 * deduplicated alert issue via `alert-lib.mjs` on failure.
 *
 * Invoked by `.github/workflows/dev-ingest-lifecycle.yml`. Never touches
 * `CRAWLER_CI_PAT` directly — this script only calls the public `/runs`
 * endpoint (which uses that credential server-side) and uses the workflow's
 * own `GITHUB_TOKEN` to manage the canary issue and the alert issue, so a
 * revoked/expired `CRAWLER_CI_PAT` cannot also silence its own alert.
 *
 * Exit code 0 = canary healthy (issue filed, labeled, and closed; any prior
 * alert issue closed). Exit code 1 = canary failed; an alert issue was filed
 * or updated with the failure reason.
 */
import { paginate, request } from '../ci-recovery/github.mjs';
import { canaryAlertTitle, closeCanaryAlert, fileOrUpdateCanaryAlert } from './alert-lib.mjs';

export const CANARY_ISSUE_LABEL = 'canary';
export const CANARY_MARKER =
  '🐤 Automated canary check from the dev-ingest-lifecycle workflow. ' +
  'This verifies the live GitHub issue-filing credential still works and is ' +
  'safe to ignore — it closes itself automatically.';

/** Build the synthetic RunBundle payload posted to the live `/runs` endpoint. */
export function buildCanaryPayload(now = new Date()) {
  return {
    runStats: { canary: true },
    recorderJsonl: '',
    logs: 'dev-ingest-lifecycle canary check',
    meta: { runId: `canary-${now.getTime()}` },
    file_issue: true,
    issue_description: CANARY_MARKER,
  };
}

/** Extract `{ owner, repo, issueNumber }` from a GitHub issue HTML URL. */
export function parseIssueUrl(issueUrl) {
  const match = String(issueUrl || '').match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/,
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], issueNumber: Number.parseInt(match[3], 10) };
}

/**
 * POST the canary payload to the live ingest endpoint and return the parsed
 * response. Throws with a descriptive message on any non-201 or malformed
 * response — never assumes success.
 */
export async function postCanaryRun({ fetchImpl = fetch, ingestUrl, now = new Date() }) {
  const response = await fetchImpl(ingestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildCanaryPayload(now)),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // fall through — reported via the status/text check below.
  }
  if (response.status !== 201) {
    throw new Error(
      `canary POST to ${ingestUrl} returned HTTP ${response.status}: ${data?.error || text.slice(0, 300)}`,
    );
  }
  if (!data || typeof data.issueUrl !== 'string') {
    throw new Error(
      `canary POST to ${ingestUrl} returned HTTP 201 without an issueUrl — the Function accepted the ` +
        `run but did not file a GitHub issue (unexpected: file_issue was true)`,
    );
  }
  return { runId: data.runId, issueUrl: data.issueUrl };
}

/** Label and close the canary-filed issue via the workflow's own token. */
async function labelAndCloseCanaryIssue({ request, token, owner, repo, issueNumber }) {
  try {
    await request(token, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: {
        name: CANARY_ISSUE_LABEL,
        color: '0e8a16',
        description: 'Automatically filed and closed by the dev-ingest-lifecycle canary check',
      },
    });
  } catch (err) {
    if (err.status !== 422) throw err;
  }
  await request(token, `/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: { labels: [CANARY_ISSUE_LABEL], state: 'closed', state_reason: 'completed' },
  });
  await request(token, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: {
      body: 'Automated canary run confirmed the GitHub issue-filing credential is healthy — closing this canary issue automatically.',
    },
  });
}

/**
 * Run the full canary lifecycle: POST, verify, label+close, and manage the
 * deduplicated alert issue. Returns a summary object; never throws — callers
 * should check `.ok` and set the process exit code accordingly.
 *
 * Two distinct failure modes are reported differently, because only one of
 * them means the live `CRAWLER_CI_PAT` credential is actually suspect:
 *   - the `/runs` POST itself fails, or returns 201 without an `issueUrl` —
 *     this is the credential/Function-health signal the canary exists to
 *     catch, so it files/updates the deduplicated "credential broken" alert.
 *   - the issue *was* filed (proving the credential works), but a later
 *     GitHub API call (labeling/closing the canary issue, or reconciling the
 *     alert issue) fails — this is a `GITHUB_TOKEN`/GitHub-API hiccup, not a
 *     broken `CRAWLER_CI_PAT`. Filing the "credential broken" alert here
 *     would misdiagnose a healthy credential, so this path fails the job
 *     (so the hiccup is still visible) without touching the alert issue.
 */
export async function runCanary({
  fetchImpl = fetch,
  requestImpl = request,
  paginateImpl = paginate,
  ingestUrl,
  token,
  alertOwner,
  alertRepo,
  workflowRunUrl = null,
  now = new Date(),
}) {
  let issueUrl;
  let parsed;
  try {
    ({ issueUrl } = await postCanaryRun({ fetchImpl, ingestUrl, now }));
    parsed = parseIssueUrl(issueUrl);
    if (!parsed) {
      throw new Error(`canary issueUrl was not a recognizable GitHub issue URL: ${issueUrl}`);
    }
    // Config drift (e.g. a stale/incorrect GITHUB_REPOSITORY app setting on
    // the live Function) can make it file real issues into an unintended
    // repository. That is itself a credential/config-health failure this
    // canary must catch — treat it exactly like a failed POST, before ever
    // attempting to label/close the returned issue with GITHUB_TOKEN (which
    // is scoped only to `alertOwner/alertRepo` and would either 403 against a
    // foreign repo, or worse, silently succeed against one it does have
    // access to).
    if (
      parsed.owner.toLowerCase() !== String(alertOwner).toLowerCase() ||
      parsed.repo.toLowerCase() !== String(alertRepo).toLowerCase()
    ) {
      throw new Error(
        `canary issueUrl pointed at ${parsed.owner}/${parsed.repo}, not the expected ` +
          `${alertOwner}/${alertRepo} — the live Function's GITHUB_REPOSITORY setting may have drifted: ${issueUrl}`,
      );
    }
  } catch (error) {
    // Credential/Function-health failure: the live endpoint never produced a
    // usable issue URL. This is exactly what the "credential broken" alert
    // exists to report.
    const errorMessage = error instanceof Error ? error.message : String(error);
    const filed = await fileOrUpdateCanaryAlert({
      request: requestImpl,
      paginate: paginateImpl,
      token,
      owner: alertOwner,
      repo: alertRepo,
      errorMessage,
      workflowRunUrl,
      now,
    });
    return {
      ok: false,
      credentialSuspected: true,
      errorMessage,
      alertAction: filed.action,
      alertIssueNumber: filed.issueNumber,
    };
  }

  try {
    await labelAndCloseCanaryIssue({
      request: requestImpl,
      token,
      owner: parsed.owner,
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
    });
    const closed = await closeCanaryAlert({
      request: requestImpl,
      paginate: paginateImpl,
      token,
      owner: alertOwner,
      repo: alertRepo,
    });
    return { ok: true, issueUrl, alertAction: closed.action };
  } catch (error) {
    // The live credential is confirmed healthy — an issue WAS filed by
    // `/runs`. This is a cleanup-step (labeling/closing/alert-reconcile)
    // failure against the workflow's own GITHUB_TOKEN, not a broken
    // CRAWLER_CI_PAT. Deliberately do NOT call fileOrUpdateCanaryAlert here:
    // doing so would file a misleading "credential broken" alert against a
    // credential that just proved itself healthy. The job still fails
    // (ok: false) so the cleanup hiccup itself is not silently swallowed.
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { ok: false, credentialSuspected: false, errorMessage, issueUrl };
  }
}

async function main() {
  const ingestUrl = process.env.INGEST_URL || 'https://crawler-dev-ingest.azurewebsites.net/runs';
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    process.stderr.write('run-canary: GITHUB_TOKEN is required\n');
    process.exit(2);
  }
  const repository = process.env.GITHUB_REPOSITORY || 'nalfeo/Crawler';
  const [alertOwner, alertRepo] = repository.split('/');
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const runId = process.env.GITHUB_RUN_ID;
  const workflowRunUrl = runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null;

  const result = await runCanary({ ingestUrl, token, alertOwner, alertRepo, workflowRunUrl });

  if (result.ok) {
    process.stdout.write(
      `canary healthy: filed and closed ${result.issueUrl} (alert issue ${result.alertAction})\n`,
    );
    process.exit(0);
  }

  if (result.credentialSuspected === false) {
    process.stderr.write(
      `canary FAILED (cleanup step only — the live credential appears healthy: issue ${result.issueUrl} was ` +
        `filed successfully): ${result.errorMessage}\n` +
        'No "credential broken" alert was filed, since the credential is not actually suspect here — ' +
        'this failure is in canary issue labeling/closing or alert reconciliation against GITHUB_TOKEN.\n',
    );
    process.exit(1);
  }

  process.stderr.write(
    `canary FAILED: ${result.errorMessage}\n` +
      `alert issue ${result.alertAction} (#${result.alertIssueNumber}) — see ${canaryAlertTitle()}\n`,
  );
  process.exit(1);
}

// Only auto-run when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
