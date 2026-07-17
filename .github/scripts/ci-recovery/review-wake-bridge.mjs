import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { paginate, request } from './github.mjs';

const ROUTER_WORKFLOW_NAME = 'CI Recovery Router';
const ROUTER_WORKFLOW_PATH = '.github/workflows/ci-recovery-router.yml';
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
  return null;
}

export function pullRequestMetadataRejection({ pullRequest, run, repository, defaultBranch }) {
  if (normalize(pullRequest?.state) !== 'open') return 'not-open';
  if (normalize(pullRequest?.base?.ref) !== normalize(defaultBranch)) return 'wrong-base';
  if (normalize(pullRequest?.base?.repo?.full_name) !== normalize(repository)) {
    return 'base-repository';
  }
  if (normalize(pullRequest?.head?.repo?.full_name) !== normalize(repository)) {
    return 'fork';
  }
  if (normalize(pullRequest?.head?.sha) !== normalize(run?.head_sha)) {
    return 'head-sha-mismatch';
  }
  return null;
}

export function changedFilesRejection({ pullRequest, changedFiles }) {
  if (
    !Number.isInteger(pullRequest?.changed_files) ||
    pullRequest.changed_files !== changedFiles.length
  ) {
    return 'changed-files-incomplete';
  }
  for (const file of changedFiles) {
    if (
      PROTECTED_WORKFLOW_PATHS.has(normalize(file?.filename)) ||
      PROTECTED_WORKFLOW_PATHS.has(normalize(file?.previous_filename))
    ) {
      return 'protected-workflow-modified';
    }
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

  // Fail closed: commit-to-PR association does not preserve event-to-PR
  // provenance. If GitHub did not populate run.pull_requests, we cannot
  // identify the exact PR that emitted the trusted review event without
  // risking associating the run with a different PR that merely shares the
  // same commit. Use the targeted operator fallback in that case.
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length === 0) {
    return { reason: 'no-associated-pr' };
  }
  const pullNumbers = [
    ...new Set(
      run.pull_requests
        .map((pullRequest) => positiveInteger(pullRequest?.number))
        .filter((number) => number !== null),
    ),
  ];
  if (pullNumbers.length === 0) return { reason: 'no-associated-pr' };

  const eligible = [];
  for (const pullNumber of pullNumbers) {
    const pullRequest = await api.getPull(pullNumber);
    const metadataRejection = pullRequestMetadataRejection({
      pullRequest,
      run,
      repository,
      defaultBranch,
    });
    if (metadataRejection) {
      process.stdout.write(
        `review wake candidate pr=#${pullNumber} skipped=${metadataRejection}\n`,
      );
      continue;
    }

    const changedFiles = await api.listPullFiles(pullNumber);
    const filesRejection = changedFilesRejection({ pullRequest, changedFiles });
    if (filesRejection) {
      process.stdout.write(`review wake candidate pr=#${pullNumber} skipped=${filesRejection}\n`);
      continue;
    }
    eligible.push(pullNumber);
  }

  if (eligible.length !== 1) {
    return { reason: `eligible-pr-count=${eligible.length}` };
  }

  return {
    prNumber: eligible[0],
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
      async getPull(number) {
        return (await request(token, `/repos/${owner}/${repo}/pulls/${number}`)).data;
      },
      async listPullFiles(number) {
        return paginate(token, `/repos/${owner}/${repo}/pulls/${number}/files`);
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
