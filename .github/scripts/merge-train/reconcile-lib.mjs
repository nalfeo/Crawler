import {
  BLOCKED_LABEL,
  QUEUE_LABEL,
  candidateFingerprint,
  commitTimestamp,
  renderStatus,
} from './state.mjs';

export class MergeTrainConflictError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MergeTrainConflictError';
  }
}

export class MergeTrainNoopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MergeTrainNoopError';
  }
}

export function isMergeTrainConflictError(error) {
  return error instanceof MergeTrainConflictError;
}

export function isMergeTrainNoopError(error) {
  return error instanceof MergeTrainNoopError;
}

export function trainCheckTitle(status, conclusion) {
  if (status !== 'completed') return 'Merge-train validation queued';
  return conclusion === 'success'
    ? 'Candidate promoted to main'
    : 'Merge-train validation could not start';
}

/**
 * Returns the newest completed main-health run that should gate promotion.
 * "Authoritative" means:
 * - scheduled main CI runs (full-health signal), or
 * - direct/non-train push runs on main.
 * Train-promoted push runs are intentionally skipped via isAttestedTrainPushSha()
 * because those fast-path pushes can skip broad CI by design.
 */
export async function latestAuthoritativeMainHealthRun(workflowRuns, isAttestedTrainPushSha) {
  for (const run of workflowRuns || []) {
    if (run?.status !== 'completed') continue;
    if (run?.event === 'schedule') return run;
    if (run?.event !== 'push') continue;
    const headSha = String(run?.head_sha || '');
    if (headSha && (await isAttestedTrainPushSha(headSha))) {
      continue;
    }
    return run;
  }
  return null;
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
        { cause: shaError },
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
      } catch (abortError) {
        process.stderr.write(`merge abort cleanup failed: ${abortError.message}\n`);
      }
      git(['reset', '--hard', baseSha]);
      throw new MergeTrainConflictError(
        `PR #${entry.number} conflicts in the cumulative candidate: ${error.message}`,
        { cause: error },
      );
    }
    if (gitCommandSucceeded(git, ['diff', '--cached', '--quiet'])) {
      throw new MergeTrainNoopError(
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
  provenanceEntries = [pr],
  waitForMergedPr,
}) {
  return promoteExactBatch({
    entries: [pr],
    candidateShas: [candidateSha],
    expectedBase,
    repository,
    live,
    fetchCurrentPr: async () => fetchCurrentPr(),
    fetchCurrentMain,
    eligible,
    git,
    createTrainCheck,
    removeLabel,
    updateStatus,
    requiredCheckName,
    provenanceEntries,
    positions: [position],
    waitForMergedPr,
  });
}

export async function promoteExactBatch({
  entries,
  candidateShas,
  expectedBase,
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
  provenanceEntries = entries,
  positions = entries.map((_, index) => index + 1),
  waitForMergedPr = async () => true,
}) {
  if (entries.length === 0 || entries.length !== candidateShas.length) {
    throw new Error('Promotion requires one candidate SHA per non-empty PR entry');
  }
  const currentMain = await fetchCurrentMain();
  const currentPrs = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const currentPr = await fetchCurrentPr(entry, index);
    const staleReason = promotionStaleReason({
      currentMain,
      currentPr,
      expectedBase,
      pr: entry,
      repository,
    });
    if (staleReason) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; ${staleReason}; rebuilding on next reconcile\n`,
      );
      return false;
    }
    const admission = await eligible(currentPr);
    if (!admission.ok) {
      process.stdout.write(`blocked promotion pr=#${entry.number} reason=${admission.reason}\n`);
      return false;
    }
    const expectedParent = index === 0 ? expectedBase : candidateShas[index - 1];
    const parent = git(['rev-parse', `${candidateShas[index]}^`]);
    if (parent !== expectedParent) {
      throw new Error(
        `Candidate ${candidateShas[index]} is not a direct child of ${expectedParent}`,
      );
    }
    const headRef = currentPr.head.ref;
    if (!/^[A-Za-z0-9._/-]+$/.test(headRef)) {
      throw new Error(`Unsafe PR head ref: ${headRef}`);
    }
    currentPrs.push(currentPr);
  }
  if (!live) {
    process.stdout.write(
      `dry-run would-promote prs=${entries.map((entry) => `#${entry.number}`).join(',')} sha=${candidateShas.at(-1)}\n`,
    );
    return false;
  }
  const finalMain = await fetchCurrentMain();
  if (finalMain !== expectedBase) {
    process.stdout.write('stale promotion; main moved during final reattestation\n');
    return false;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const finalPr = await fetchCurrentPr(entry, index);
    const staleReason = promotionStaleReason({
      currentMain: finalMain,
      currentPr: finalPr,
      expectedBase,
      pr: entry,
      repository,
    });
    const admission = staleReason ? null : await eligible(finalPr);
    if (staleReason || !admission.ok) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; ${staleReason || admission.reason}; final reattestation failed\n`,
      );
      return false;
    }
    currentPrs[index] = finalPr;
  }
  const finalCandidateSha = candidateShas.at(-1);
  const promotionFingerprint = candidateFingerprint(expectedBase, currentPrs);
  await createTrainCheck(
    finalCandidateSha,
    promotionFingerprint,
    'completed',
    'success',
    requiredCheckName,
    provenanceEntries,
  );
  try {
    const refUpdates = currentPrs.map(
      (currentPr) => `${finalCandidateSha}:refs/heads/${currentPr.head.ref}`,
    );
    const leases = currentPrs.map(
      (currentPr) => `--force-with-lease=refs/heads/${currentPr.head.ref}:${currentPr.head.sha}`,
    );
    git([
      'push',
      '--atomic',
      'origin',
      ...refUpdates,
      `${finalCandidateSha}:refs/heads/main`,
      ...leases,
      `--force-with-lease=refs/heads/main:${expectedBase}`,
    ]);
  } catch (error) {
    await createTrainCheck(
      finalCandidateSha,
      promotionFingerprint,
      'completed',
      'failure',
      requiredCheckName,
      provenanceEntries,
    );
    throw error;
  }
  for (const entry of entries) {
    if (!(await waitForMergedPr(entry, finalCandidateSha))) {
      await createTrainCheck(
        finalCandidateSha,
        promotionFingerprint,
        'completed',
        'failure',
        `${requiredCheckName}-promotion-postcondition`,
        provenanceEntries,
      );
      throw new Error(
        `PR #${entry.number} was not recorded as merged after atomic promotion to ${finalCandidateSha}`,
      );
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    await removeLabel(entry.number, QUEUE_LABEL);
    await removeLabel(entry.number, BLOCKED_LABEL);
    await updateStatus(
      entry.number,
      renderStatus({
        position: positions[index],
        candidateSha: finalCandidateSha,
        state: 'merged',
        detail: 'The exact validated combined candidate fast-forwarded main atomically.',
      }),
    );
  }
  process.stdout.write(
    `promoted prs=${entries.map((entry) => `#${entry.number}`).join(',')} sha=${finalCandidateSha}\n`,
  );
  return true;
}
