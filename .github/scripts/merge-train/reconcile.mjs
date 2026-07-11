import { execFileSync } from 'node:child_process';

import { listReviewThreads, paginate, request } from '../ci-recovery/github.mjs';
import {
  BLOCKED_LABEL,
  CANDIDATE_CHECK_NAME,
  candidateFingerprint,
  candidateRef,
  commitTimestamp,
  DEFAULT_ADMISSION_CHECKS,
  normalizeMode,
  QUEUE_LABEL,
  queueEntries,
  REQUIRED_CHECK_NAME,
  renderStatus,
  STATUS_MARKER,
  successfulChecks,
  trainCheckState,
} from './state.mjs';

const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const token = process.env.MERGE_TRAIN_TOKEN || process.env.GITHUB_TOKEN || '';
const mode = normalizeMode(process.env.MERGE_TRAIN_MODE);
const live = mode === 'live';
const admissionChecks = (process.env.MERGE_TRAIN_ADMISSION_CHECKS || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const requiredAdmissionChecks =
  admissionChecks.length > 0 ? admissionChecks : DEFAULT_ADMISSION_CHECKS;

if (!owner || !repo || !token) {
  throw new Error('Merge train requires GITHUB_REPOSITORY and a GitHub token');
}
if (mode === 'off') {
  process.stdout.write('Merge train is disabled\n');
  process.exit(0);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env || {}) },
  }).trim();
}

async function checkRuns(sha) {
  const response = await request(
    token,
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  return response.data.check_runs || [];
}

async function ensureLabel(name, color, description) {
  if (!live) return;
  try {
    await request(token, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: { name, color, description },
    });
  } catch (error) {
    if (error.status !== 422) throw error;
  }
}

async function setLabel(prNumber, name) {
  if (!live) return;
  await request(token, `/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
    method: 'POST',
    body: { labels: [name] },
  });
}

async function removeLabel(prNumber, name) {
  if (!live) return;
  try {
    await request(
      token,
      `/repos/${owner}/${repo}/issues/${prNumber}/labels/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function updateStatus(prNumber, status) {
  if (!live) {
    process.stdout.write(`dry-run pr=#${prNumber} ${status.replace(/\n/g, ' ')}\n`);
    return;
  }
  const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`);
  const stateComments = comments.filter((comment) =>
    String(comment.body || '').includes(STATUS_MARKER),
  );
  if (stateComments.length > 1) {
    throw new Error(`PR #${prNumber} has duplicate merge-train state comments`);
  }
  if (stateComments[0]) {
    await request(token, `/repos/${owner}/${repo}/issues/comments/${stateComments[0].id}`, {
      method: 'PATCH',
      body: { body: status },
    });
  } else {
    await request(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: { body: status },
    });
  }
}

async function eligible(pr) {
  const runs = await checkRuns(pr.head.sha);
  if (!successfulChecks(runs, requiredAdmissionChecks)) {
    return { ok: false, reason: `waiting for ${requiredAdmissionChecks.join(', ')}` };
  }
  const review = await listReviewThreads(token, owner, repo, pr.number);
  if (review.threads.some((thread) => !thread.isResolved)) {
    return { ok: false, reason: 'unresolved review threads' };
  }
  return { ok: true };
}

function buildCandidate(baseSha, entries, refName) {
  git(['fetch', 'origin', 'main', '--prune']);
  for (const entry of entries) {
    git([
      'fetch',
      'origin',
      `refs/pull/${entry.number}/head:refs/remotes/merge-train/pr-${entry.number}`,
      '--force',
    ]);
  }
  git(['checkout', '--detach', baseSha]);
  for (const entry of entries) {
    try {
      git(['merge', '--squash', '--no-commit', `refs/remotes/merge-train/pr-${entry.number}`]);
    } catch (error) {
      try {
        git(['merge', '--abort']);
      } catch {}
      git(['reset', '--hard', baseSha]);
      throw new Error(
        `PR #${entry.number} conflicts in the cumulative candidate: ${error.message}`,
      );
    }
    const title = String(entry.title)
      .replace(/[\r\n]+/g, ' ')
      .trim();
    const timestamp = commitTimestamp(entry);
    git(
      [
        'commit',
        '-m',
        `${title} (#${entry.number})`,
        '-m',
        `Merge-Train-PR: ${entry.number}\nMerge-Train-Original-Head: ${entry.head.sha}`,
      ],
      {
        env: {
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_DATE: timestamp,
          GIT_AUTHOR_NAME: 'crawler-merge-train[bot]',
          GIT_AUTHOR_EMAIL: 'crawler-merge-train[bot]@users.noreply.github.com',
          GIT_COMMITTER_NAME: 'crawler-merge-train[bot]',
          GIT_COMMITTER_EMAIL: 'crawler-merge-train[bot]@users.noreply.github.com',
        },
      },
    );
  }
  const sha = git(['rev-parse', 'HEAD']);
  if (live) {
    git(['push', '--force', 'origin', `${sha}:refs/heads/${refName}`]);
  }
  return sha;
}

async function createTrainCheck(
  sha,
  fingerprint,
  status,
  conclusion = undefined,
  name = CANDIDATE_CHECK_NAME,
) {
  if (!live) return;
  await request(token, `/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    body: {
      name,
      head_sha: sha,
      status,
      external_id: fingerprint,
      ...(conclusion ? { conclusion } : {}),
      output: {
        title:
          status === 'completed'
            ? 'Merge-train validation could not start'
            : 'Merge-train validation queued',
        summary: `Fingerprint: ${fingerprint}`,
      },
    },
  });
}

async function dispatchValidation(sha, fingerprint, entries) {
  if (!live) return;
  await createTrainCheck(sha, fingerprint, 'in_progress');
  try {
    await request(
      token,
      `/repos/${owner}/${repo}/actions/workflows/merge-train-validate.yml/dispatches`,
      {
        method: 'POST',
        body: {
          ref: 'main',
          inputs: {
            candidate_sha: sha,
            fingerprint,
            pr_numbers: entries.map((entry) => entry.number).join(','),
          },
        },
      },
    );
  } catch (error) {
    await createTrainCheck(sha, fingerprint, 'completed', 'failure');
    throw error;
  }
}

async function promote(pr, candidateSha, expectedBase, position) {
  const currentPr = (await request(token, `/repos/${owner}/${repo}/pulls/${pr.number}`)).data;
  const currentMain = (await request(token, `/repos/${owner}/${repo}/git/ref/heads/main`)).data
    .object.sha;
  if (
    currentMain !== expectedBase ||
    currentPr.head.sha !== pr.head.sha ||
    currentPr.title !== pr.title ||
    currentPr.state !== 'open'
  ) {
    process.stdout.write(`stale promotion pr=#${pr.number}; rebuilding on next reconcile\n`);
    return false;
  }
  const admission = await eligible(currentPr);
  if (!admission.ok) {
    process.stdout.write(`blocked promotion pr=#${pr.number} reason=${admission.reason}\n`);
    return false;
  }
  const parent = git(['rev-parse', `${candidateSha}^`]);
  if (parent !== expectedBase) {
    throw new Error(`Candidate ${candidateSha} is not a direct child of current main`);
  }
  if (!live) {
    process.stdout.write(`dry-run would-promote pr=#${pr.number} sha=${candidateSha}\n`);
    return false;
  }
  const promotionFingerprint = candidateFingerprint(expectedBase, [currentPr]);
  await createTrainCheck(
    candidateSha,
    promotionFingerprint,
    'completed',
    'success',
    REQUIRED_CHECK_NAME,
  );
  const headRef = currentPr.head.ref;
  if (!/^[A-Za-z0-9._/-]+$/.test(headRef)) {
    throw new Error(`Unsafe PR head ref: ${headRef}`);
  }
  try {
    git([
      'push',
      '--atomic',
      'origin',
      `${candidateSha}:refs/heads/${headRef}`,
      `${candidateSha}:refs/heads/main`,
      `--force-with-lease=refs/heads/${headRef}:${currentPr.head.sha}`,
      `--force-with-lease=refs/heads/main:${expectedBase}`,
    ]);
  } catch (error) {
    await createTrainCheck(
      candidateSha,
      promotionFingerprint,
      'completed',
      'failure',
      REQUIRED_CHECK_NAME,
    );
    throw error;
  }
  await removeLabel(pr.number, QUEUE_LABEL);
  await removeLabel(pr.number, BLOCKED_LABEL);
  await updateStatus(
    pr.number,
    renderStatus({
      position,
      candidateSha,
      state: 'merged',
      detail: 'The exact validated candidate fast-forwarded main.',
    }),
  );
  process.stdout.write(`promoted pr=#${pr.number} sha=${candidateSha}\n`);
  return true;
}

await ensureLabel(QUEUE_LABEL, '1f6feb', 'Ready for the repository-managed merge train');
await ensureLabel(BLOCKED_LABEL, 'd1242f', 'Merge-train candidate needs intervention');

const pulls = await paginate(token, `/repos/${owner}/${repo}/pulls?state=open&base=main`);
const queued = queueEntries(pulls, repository);
if (queued.length === 0) {
  process.stdout.write('Merge train is empty\n');
  process.exit(0);
}

const admitted = [];
for (const pr of queued) {
  const admission = await eligible(pr);
  if (admission.ok) {
    admitted.push(pr);
  } else {
    await updateStatus(
      pr.number,
      renderStatus({
        position: queued.indexOf(pr) + 1,
        candidateSha: '',
        state: 'waiting',
        detail: admission.reason,
      }),
    );
  }
}

const train = admitted.slice(0, 2);
if (train.length === 0) {
  process.stdout.write('No admitted PR is ready for candidate construction\n');
  process.exit(0);
}

const mainSha = (await request(token, `/repos/${owner}/${repo}/git/ref/heads/main`)).data.object
  .sha;
for (let index = 0; index < train.length; index += 1) {
  const entries = train.slice(0, index + 1);
  const fingerprint = candidateFingerprint(mainSha, entries);
  const refName = candidateRef(index + 1, fingerprint);
  let candidateSha;
  try {
    candidateSha = buildCandidate(mainSha, entries, refName);
    await removeLabel(train[index].number, BLOCKED_LABEL);
  } catch (error) {
    await setLabel(train[index].number, BLOCKED_LABEL);
    await removeLabel(train[index].number, QUEUE_LABEL);
    await updateStatus(
      train[index].number,
      renderStatus({
        position: index + 1,
        candidateSha: '',
        state: 'blocked',
        detail: error.message,
      }),
    );
    break;
  }

  if (!live) {
    await updateStatus(
      train[index].number,
      renderStatus({
        position: index + 1,
        candidateSha,
        state: 'dry-run',
        detail: `Would create ${refName} and dispatch validation.`,
      }),
    );
    continue;
  }

  git(['fetch', 'origin', `${refName}:refs/remotes/origin/${refName}`, '--force']);
  const state = trainCheckState(await checkRuns(candidateSha));
  if (state === 'missing') {
    await dispatchValidation(candidateSha, fingerprint, entries);
  }
  await updateStatus(
    train[index].number,
    renderStatus({
      position: index + 1,
      candidateSha,
      state: state === 'missing' ? 'testing' : state,
      detail:
        state === 'failure'
          ? 'Candidate validation failed; inspect its Merge Train Validation run.'
          : 'Candidate is immutable and bound to the listed PR revisions.',
    }),
  );
  if (index === 0 && state === 'success') {
    await promote(train[0], candidateSha, mainSha, 1);
    break;
  }
}
