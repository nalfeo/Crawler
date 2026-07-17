import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { request } from './github.mjs';

const ROUTER_WORKFLOW_NAME = 'CI Recovery Router';
const ROUTER_WORKFLOW_PATH = '.github/workflows/ci-recovery-router.yml';
// The router encodes the trusted source PR number into its run-name for review
// events (see ci-recovery-router.yml). GitHub surfaces run-name as the run
// object's `display_title` (the `name` field stays the workflow name), so the
// bridge reads it back to select the exact PR that emitted the review event.
const REVIEW_RUN_NAME_PR_PREFIX = `${ROUTER_WORKFLOW_NAME}: review-wake pr-`;
const ALLOWED_SOURCE_EVENTS = new Set(['pull_request_review', 'pull_request_review_comment']);
const TRUSTED_COPILOT_ACTORS = new Map([[175728472, { login: 'copilot', type: 'bot' }]]);
const PROTECTED_WORKFLOW_PATHS = new Set([
  '.github/workflows/ci-recovery-router.yml',
  '.github/workflows/ci-recovery-review-wake-bridge.yml',
  '.github/workflows/ci-recovery.yml',
]);

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function trimRef(value) {
  return String(value ?? '').trim();
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function actorIsTrusted(actor) {
  const actorId = positiveInteger(actor?.id);
  const expected = TRUSTED_COPILOT_ACTORS.get(actorId);
  return (
    expected !== undefined &&
    normalize(actor?.login) === expected.login &&
    normalize(actor?.type) === expected.type
  );
}

export function runRejection({ payload, run, repository }) {
  const payloadRun = payload?.workflow_run;
  if (payload?.action !== 'completed') return `action=${payload?.action}`;
  if (positiveInteger(payloadRun?.id) !== positiveInteger(run?.id)) return 'run-id-mismatch';
  if (normalize(run?.name) !== normalize(ROUTER_WORKFLOW_NAME)) return 'workflow-name';
  if (run?.path !== ROUTER_WORKFLOW_PATH) return 'workflow-path';
  if (normalize(run?.status) !== 'completed') return `status=${run?.status}`;
  if (normalize(run?.conclusion) !== 'action_required') {
    return `conclusion=${run?.conclusion}`;
  }
  if (!ALLOWED_SOURCE_EVENTS.has(normalize(run?.event))) return `event=${run?.event}`;
  if (normalize(payload?.repository?.full_name) !== normalize(repository)) {
    return 'payload-repository';
  }
  if (normalize(run?.repository?.full_name) !== normalize(repository)) {
    return 'run-repository';
  }
  if (normalize(run?.head_repository?.full_name) !== normalize(repository)) {
    return 'run-head-repository';
  }
  if (!actorIsTrusted(run?.actor)) return 'actor';
  if (!actorIsTrusted(run?.triggering_actor)) return 'triggering-actor';
  if (!/^[0-9a-f]{40}$/i.test(String(run?.head_sha ?? ''))) return 'head-sha';
  // run.head_branch is a GitHub-set, immutable attribute of the run (never
  // derived from a workflow file), used below as a trusted anchor to the exact
  // branch the reviewed run executed on.
  if (!String(run?.head_branch ?? '').trim()) return 'head-branch';
  return null;
}

/**
 * Extract the source PR number the router encoded into its run-name for review
 * events, surfaced by GitHub as the run object's `display_title`. Returns null
 * when the marker is absent (e.g. a non-review router run, or run-name not yet
 * deployed), so callers fail closed.
 */
export function sourcePrFromRunName(run) {
  const prefix = normalize(REVIEW_RUN_NAME_PR_PREFIX);
  const value = normalize(run?.display_title);
  if (!value.startsWith(prefix)) return null;
  return positiveInteger(value.slice(prefix.length));
}

export function pullRequestMetadataRejection({ pullRequest, run, repository, defaultBranch }) {
  if (normalize(pullRequest?.state) !== 'open') return 'not-open';
  if (trimRef(pullRequest?.base?.ref) !== trimRef(defaultBranch)) return 'wrong-base';
  if (normalize(pullRequest?.base?.repo?.full_name) !== normalize(repository)) {
    return 'base-repository';
  }
  if (normalize(pullRequest?.head?.repo?.full_name) !== normalize(repository)) {
    return 'fork';
  }
  if (normalize(pullRequest?.head?.sha) !== normalize(run?.head_sha)) {
    return 'head-sha-mismatch';
  }
  // Trusted immutable anchor: the candidate's head ref must equal the branch the
  // reviewed run executed on. This rejects an unrelated PR that merely shares
  // run.head_sha on a different branch (run.pull_requests associates PRs by head
  // SHA *or* branch and is not event-to-PR provenance). Branch names are
  // case-sensitive in git/GitHub; compare exactly (trim only).
  if (trimRef(pullRequest?.head?.ref) !== trimRef(run?.head_branch)) {
    return 'head-branch-mismatch';
  }
  return null;
}

export async function inspectReviewWake({ payload, repository, api }) {
  const runId = positiveInteger(payload?.workflow_run?.id);
  if (!runId) return { reason: 'missing-run-id' };

  const run = await api.getRun(runId);
  const rejection = runRejection({ payload, run, repository });
  if (rejection) return { reason: rejection };

  const defaultBranch = String(payload?.repository?.default_branch || '');
  if (!defaultBranch) return { reason: 'missing-default-branch' };

  // The source-PR binding below comes from the router's run-name expression.
  // Prove that expression came from the trusted default-branch workflow before
  // parsing it: review events can otherwise evaluate a PR-modified workflow
  // definition and forge display_title. Git blob identity is exact and does not
  // depend on first identifying the source PR.
  const workflowSnapshots = await Promise.all(
    [...PROTECTED_WORKFLOW_PATHS].map(async (path) => {
      const [runFile, trustedFile] = await Promise.all([
        api.getWorkflowFile(path, run.head_sha),
        api.getWorkflowFile(path, defaultBranch),
      ]);
      return { path, runFile, trustedFile };
    }),
  );
  const routerSnapshot = workflowSnapshots.find(({ path }) => path === ROUTER_WORKFLOW_PATH);
  if (
    !routerSnapshot?.runFile?.sha ||
    !routerSnapshot.trustedFile?.sha ||
    routerSnapshot.runFile.sha !== routerSnapshot.trustedFile.sha
  ) {
    return { reason: 'router-workflow-untrusted' };
  }
  if (
    workflowSnapshots.some(
      ({ runFile, trustedFile }) =>
        !runFile?.sha || !trustedFile?.sha || runFile.sha !== trustedFile.sha,
    )
  ) {
    return { reason: 'protected-workflow-modified' };
  }

  // Select the source PR from the trusted run-name binding, NOT from the
  // head-SHA/branch association in run.pull_requests. GitHub documents
  // run.pull_requests as open PRs matching the run head SHA or branch and warns
  // they do not necessarily indicate the PR that triggered the run. If the
  // reviewed PR's head moves after the run, an unrelated PR sitting at
  // run.head_sha could otherwise become the sole "eligible" candidate and be
  // recovered in its place. Instead we recover exactly the PR the router
  // encoded into its run-name (from the trusted event payload), require the
  // association to corroborate it, and re-validate that PR against the immutable
  // run head SHA and branch.
  const sourcePr = sourcePrFromRunName(run);
  if (!sourcePr) return { reason: 'missing-source-pr-binding' };

  // Fail closed when GitHub did not populate the association at all: without it
  // we cannot corroborate the run-name binding, so defer to the operator
  // fallback rather than trusting run-name alone.
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length === 0) {
    return { reason: 'no-associated-pr' };
  }
  const associatedNumbers = new Set(
    run.pull_requests
      .map((pullRequest) => positiveInteger(pullRequest?.number))
      .filter((number) => number !== null),
  );
  if (!associatedNumbers.has(sourcePr)) {
    // The trusted run-name and GitHub's own association disagree on the source
    // PR; do not dispatch.
    return { reason: 'source-pr-not-associated' };
  }

  const pullRequest = await api.getPull(sourcePr);
  const metadataRejection = pullRequestMetadataRejection({
    pullRequest,
    run,
    repository,
    defaultBranch,
  });
  if (metadataRejection) {
    process.stdout.write(`review wake source pr=#${sourcePr} skipped=${metadataRejection}\n`);
    return { reason: metadataRejection };
  }

  return {
    prNumber: sourcePr,
    trigger: `trusted-review-wake:${run.event}:run-${run.id}`,
    // Bind the dispatch to the exact head this trust decision (protected-file
    // and same-repository checks) was made against. Recovery re-fetches the
    // live PR head; without this the head can be synchronized between
    // inspection and reconciliation, defeating the protected-workflow gate.
    headSha: String(run.head_sha).toLowerCase(),
  };
}

export async function runFromEnv(env = process.env) {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  if (
    env.GITHUB_EVENT_NAME !== 'workflow_run' ||
    !token ||
    !owner ||
    !repo ||
    !env.GITHUB_EVENT_PATH ||
    !env.GITHUB_OUTPUT
  ) {
    throw new Error(
      'Missing workflow_run event, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, or GITHUB_OUTPUT',
    );
  }

  const payload = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await inspectReviewWake({
    payload,
    repository,
    api: {
      async getRun(runId) {
        return (await request(token, `/repos/${owner}/${repo}/actions/runs/${runId}`)).data;
      },
      async getWorkflowFile(path, ref) {
        try {
          return (
            await request(
              token,
              `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
            )
          ).data;
        } catch (error) {
          if (error.status === 404) return null;
          throw error;
        }
      },
      async getPull(number) {
        return (await request(token, `/repos/${owner}/${repo}/pulls/${number}`)).data;
      },
    },
  });

  if (!result.prNumber) {
    process.stdout.write(`trusted review wake skipped reason=${result.reason}\n`);
    return;
  }

  await appendFile(
    env.GITHUB_OUTPUT,
    `pr_number=${result.prNumber}\ntrigger=${result.trigger}\nhead_sha=${result.headSha}\n`,
    'utf8',
  );
  process.stdout.write(
    `trusted review wake eligible pr=#${result.prNumber} trigger=${result.trigger} head_sha=${result.headSha}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromEnv();
}
