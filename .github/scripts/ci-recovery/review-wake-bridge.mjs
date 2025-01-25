import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { paginate, request } from './github.mjs';

const ROUTER_WORKFLOW_NAME = 'CI Recovery Router';
const ROUTER_WORKFLOW_PATH = '.github/workflows/ci-recovery-router.yml';
const ALLOWED_SOURCE_EVENTS = new Set(['pull_request_review', 'pull_request_review_comment']);
const TRUSTED_COPILOT_ACTORS = new Map([[175728472, { login: 'copilot', type: 'bot' }]]);
const TRUSTED_REVIEWER_LOGINS = new Set([
  'copilot',
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]',
]);
const REVIEW_EVENT_MAX_DELAY_MS = 30_000;
export const PROTECTED_WORKFLOW_PATHS = new Set([
  '.github/workflows/ci-recovery-router.yml',
  '.github/workflows/ci-recovery-review-wake-bridge.yml',
  '.github/workflows/ci-recovery.yml',
  '.github/workflows/auto-rebase-prs.yml',
  '.github/scripts/ci-recovery/review-wake-bridge.mjs',
  '.github/scripts/ci-recovery/router.mjs',
  '.github/scripts/ci-recovery/reconcile.mjs',
  '.github/scripts/ci-recovery/github.mjs',
  '.github/scripts/ci-recovery/state.mjs',
  '.github/scripts/ci-recovery/approval.mjs',
  '.github/scripts/merge-train/state.mjs',
  '.github/scripts/merge-train/human-approval.mjs',
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

function workflowBlobMatchesBase(baseFile, headFile) {
  if (baseFile === null && headFile === null) return true;
  return (
    typeof baseFile?.sha === 'string' &&
    typeof headFile?.sha === 'string' &&
    baseFile.sha === headFile.sha
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
  if (!Number.isFinite(Date.parse(String(run?.created_at ?? '')))) return 'run-created-at';
  return null;
}

function reviewerIsTrusted(reviewer) {
  return (
    positiveInteger(reviewer?.id) === 175728472 &&
    normalize(reviewer?.type) === 'bot' &&
    TRUSTED_REVIEWER_LOGINS.has(normalize(reviewer?.login))
  );
}

function reviewEvidenceMatchesRun({ evidence, event, run, repository, prNumber, apiBaseUrl }) {
  if (!reviewerIsTrusted(evidence?.user)) return false;
  if (normalize(evidence?.commit_id) !== normalize(run.head_sha)) return false;

  const evidenceTimestamp =
    event === 'pull_request_review_comment' ? evidence?.created_at : evidence?.submitted_at;
  const evidenceAt = Date.parse(String(evidenceTimestamp ?? ''));
  const runAt = Date.parse(String(run.created_at));
  const delayMs = runAt - evidenceAt;
  if (!Number.isFinite(evidenceAt) || delayMs < 0 || delayMs > REVIEW_EVENT_MAX_DELAY_MS) {
    return false;
  }

  if (event === 'pull_request_review_comment') {
    const expectedUrl = `${apiBaseUrl.replace(/\/$/, '')}/repos/${repository}/pulls/${prNumber}`;
    if (normalize(evidence?.pull_request_url) !== normalize(expectedUrl)) return false;
  }
  return true;
}

async function sourcePrFromTrustedReviewEvidence({ run, repository, api, apiBaseUrl }) {
  const associatedNumbers = [
    ...new Set(run.pull_requests.map((pullRequest) => positiveInteger(pullRequest?.number))),
  ];
  if (associatedNumbers.some((number) => number === null)) {
    return { reason: 'invalid-associated-pr' };
  }

  const since = new Date(Date.parse(run.created_at) - REVIEW_EVENT_MAX_DELAY_MS).toISOString();
  const candidatesWithEvidence = [];
  for (const prNumber of associatedNumbers) {
    const evidenceRecords = await api.listReviewEvidence(prNumber, run.event, since);
    if (
      evidenceRecords.some((evidence) =>
        reviewEvidenceMatchesRun({
          evidence,
          event: run.event,
          run,
          repository,
          prNumber,
          apiBaseUrl,
        }),
      )
    ) {
      candidatesWithEvidence.push(prNumber);
    }
  }

  if (candidatesWithEvidence.length === 0) {
    return { reason: 'missing-review-event-provenance' };
  }
  if (candidatesWithEvidence.length > 1) {
    return { reason: 'ambiguous-review-event-provenance' };
  }
  return { sourcePr: candidatesWithEvidence[0] };
}

export function pullRequestMetadataRejection({ pullRequest, run, repository, defaultBranch }) {
  if (normalize(pullRequest?.state) !== 'open') return 'not-open';
  if (pullRequest?.draft !== false) return 'pr-drafted';
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

export async function inspectReviewWake({
  payload,
  repository,
  api,
  apiBaseUrl = 'https://api.github.com',
}) {
  const runId = positiveInteger(payload?.workflow_run?.id);
  if (!runId) return { reason: 'missing-run-id' };

  const run = await api.getRun(runId);
  const rejection = runRejection({ payload, run, repository });
  if (rejection) return { reason: rejection };

  const defaultBranch = String(payload?.repository?.default_branch || '');
  if (!defaultBranch) return { reason: 'missing-default-branch' };
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length === 0) {
    return { reason: 'no-associated-pr' };
  }

  // Compare each protected path between the branch's immutable fork point and
  // the immutable run head. This detects branch-authored modifications,
  // additions, deletions, and renames without comparing against today's default
  // tip (which would incorrectly reject stale branches that merely predate a
  // trusted workflow addition/edit).
  const comparison = await api.compareCommits(defaultBranch, run.head_sha);
  const mergeBaseSha = String(comparison?.merge_base_commit?.sha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(mergeBaseSha)) return { reason: 'missing-merge-base' };

  const protectedSnapshots = await Promise.all(
    [...PROTECTED_WORKFLOW_PATHS].map(async (path) => {
      const [baseFile, headFile] = await Promise.all([
        api.getWorkflowFile(path, mergeBaseSha),
        api.getWorkflowFile(path, run.head_sha),
      ]);
      return { path, baseFile, headFile };
    }),
  );
  const routerSnapshot = protectedSnapshots.find(({ path }) => path === ROUTER_WORKFLOW_PATH);
  if (
    !routerSnapshot ||
    !workflowBlobMatchesBase(routerSnapshot.baseFile, routerSnapshot.headFile)
  ) {
    return { reason: 'router-workflow-untrusted' };
  }
  if (
    protectedSnapshots.some(
      ({ baseFile, headFile }) => !workflowBlobMatchesBase(baseFile, headFile),
    )
  ) {
    return { reason: 'protected-workflow-modified' };
  }

  // GitHub parks these runs before evaluating workflow YAML, so run-name is not
  // available. Treat run.pull_requests only as a bounded candidate set, then
  // select exactly one PR using the immutable trusted review/comment record that
  // immediately preceded this run and names the same commit. Missing or
  // cross-PR-ambiguous evidence fails closed to the exact operator fallback.
  const source = await sourcePrFromTrustedReviewEvidence({ run, repository, api, apiBaseUrl });
  if (!source.sourcePr) return { reason: source.reason };
  const sourcePr = source.sourcePr;

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
    apiBaseUrl: env.GITHUB_API_URL || 'https://api.github.com',
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
      async compareCommits(base, head) {
        return (
          await request(
            token,
            `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
          )
        ).data;
      },
      async getPull(number) {
        return (await request(token, `/repos/${owner}/${repo}/pulls/${number}`)).data;
      },
      async listReviewEvidence(number, event, since) {
        if (event === 'pull_request_review_comment') {
          return paginate(
            token,
            `/repos/${owner}/${repo}/pulls/${number}/comments?sort=created&direction=desc&since=${encodeURIComponent(since)}`,
          );
        }
        return paginate(token, `/repos/${owner}/${repo}/pulls/${number}/reviews`);
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
