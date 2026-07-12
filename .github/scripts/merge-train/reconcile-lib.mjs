import {
  BLOCKED_LABEL,
  QUEUE_LABEL,
  candidateFingerprint,
  commitTimestamp,
  renderStatus,
} from './state.mjs';

export class MergeTrainConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MergeTrainConflictError';
  }
}

export function isMergeTrainConflictError(error) {
  return error instanceof MergeTrainConflictError;
}

export function trainCheckTitle(status, conclusion) {
  if (status !== 'completed') return 'Merge-train validation queued';
  return conclusion === 'success'
    ? 'Candidate promoted to main'
    : 'Merge-train validation could not start';
}

function hasLabel(pr, name) {
  return (pr.labels || []).some((label) => label.name === name);
}

function sameRepository(pr, repository) {
  return pr.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase();
}

function fetchCandidateHead(git, entry) {
  const refName = `refs/remotes/merge-train/pr-${entry.number}`;
  const expectedSha = String(entry.head?.sha || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(expectedSha)) {
    throw new Error(`PR #${entry.number} has invalid API head SHA: ${expectedSha || '<empty>'}`);
  }
  try {
    git(['fetch', 'origin', `${expectedSha}:${refName}`, '--force']);
  } catch (shaError) {
    const headRef = String(entry.head?.ref || '').trim();
    if (!headRef) {
      throw new Error(
        `PR #${entry.number} head ${expectedSha} is not fetchable and has no branch ref fallback: ${shaError.message}`,
      );
    }
    git(['fetch', 'origin', `refs/heads/${headRef}:${refName}`, '--force']);
  }
  const fetchedSha = git(['rev-parse', refName]);
  if (fetchedSha !== expectedSha) {
    throw new Error(
      `PR #${entry.number} head changed while building candidate (expected ${expectedSha}, got ${fetchedSha}); reconcile will retry on the next run`,
    );
  }
  return refName;
}

function gitCommandSucceeded(git, args) {
  try {
    git(args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export function buildCandidate({ baseSha, entries, refName, git, live }) {
  git(['fetch', 'origin', 'main', '--prune']);
  const candidateRefs = entries.map((entry) => fetchCandidateHead(git, entry));
  git(['checkout', '--detach', baseSha]);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const candidateRef = candidateRefs[index];
    try {
      git(['merge', '--squash', '--no-commit', candidateRef]);
    } catch (error) {
      try {
        git(['merge', '--abort']);
      } catch {}
      git(['reset', '--hard', baseSha]);
      throw new MergeTrainConflictError(
        `PR #${entry.number} conflicts in the cumulative candidate: ${error.message}`,
      );
    }
    if (gitCommandSucceeded(git, ['diff', '--cached', '--quiet'])) {
      throw new MergeTrainConflictError(
        `PR #${entry.number} no longer changes main; its squash diff is already present in the candidate base`,
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

export function promotionStaleReason({ currentMain, currentPr, expectedBase, pr, repository }) {
  if (currentMain !== expectedBase) return 'main moved since validation';
  if (currentPr.head?.sha !== pr.head?.sha) return 'PR head changed since validation';
  if (currentPr.title !== pr.title) return 'PR title changed since validation';
  if (currentPr.state !== 'open') return 'PR is no longer open';
  if (currentPr.draft) return 'PR is now a draft';
  if (currentPr.base?.ref !== 'main')
    return `PR retargeted to ${currentPr.base?.ref || '<unknown>'}`;
  if (!sameRepository(currentPr, repository)) return 'PR head repository changed';
  if (!hasLabel(currentPr, QUEUE_LABEL)) return `PR no longer has the ${QUEUE_LABEL} label`;
  if (hasLabel(currentPr, BLOCKED_LABEL)) return `PR is marked ${BLOCKED_LABEL}`;
  return null;
}

export async function promoteExactCandidate({
  pr,
  candidateSha,
  expectedBase,
  position,
  repository,
  live,
  fetchCurrentPr,
  fetchCurrentMain,
  eligible,
  git,
  createTrainCheck,
  removeLabel,
  updateStatus,
  requiredCheckName,
}) {
  const currentPr = await fetchCurrentPr();
  const currentMain = await fetchCurrentMain();
  const staleReason = promotionStaleReason({
    currentMain,
    currentPr,
    expectedBase,
    pr,
    repository,
  });
  if (staleReason) {
    process.stdout.write(
      `stale promotion pr=#${pr.number}; ${staleReason}; rebuilding on next reconcile\n`,
    );
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
  const headRef = currentPr.head.ref;
  if (!/^[A-Za-z0-9._/-]+$/.test(headRef)) {
    throw new Error(`Unsafe PR head ref: ${headRef}`);
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
    requiredCheckName,
  );
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
      requiredCheckName,
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
