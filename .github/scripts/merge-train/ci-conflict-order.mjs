import {
  COORDINATOR_MARKER,
  changeStatsFromFiles,
  ciFilesFor,
  discoverCoordinationClusters,
  mergeCoordinationGroups,
  rankPullRequests,
  selectCoordination,
  parseCoordinatorComment,
} from '../ci-conflict-coordinator/state.mjs';
import { bindProofToLeader, buildSupersessionProofs } from '../ci-conflict-coordinator/proof.mjs';
import { listClosingIssues } from '../ci-recovery/github.mjs';
import {
  STATE_MARKER as RECOVERY_STATE_MARKER,
  TRUSTED_ASSOCIATIONS,
  TRUSTED_BOT_LOGINS,
  assertOwnershipInvariant,
  isHealthyRecoveryOwner,
  parseStateComment,
} from '../ci-recovery/state.mjs';
import { resolveHumanApprovalRejection } from './human-approval.mjs';
import { successfulChecks } from './state.mjs';

function labelsOf(pull) {
  return new Set((pull.labels || []).map((label) => label.name));
}

function pathsForFiles(files) {
  return (files || []).flatMap((file) =>
    [file?.filename, file?.previous_filename].filter(
      (value) => typeof value === 'string' && value.length > 0,
    ),
  );
}

function normalizePull(pull, files) {
  const paths = pathsForFiles(files);
  const { additions, deletions, changedFiles } = changeStatsFromFiles(files);
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    createdAt: pull.created_at,
    // fetchOpenPulls() uses the list endpoint which does not carry additions,
    // deletions, or changed_files. The candidate PR may be replaced with a
    // full GET response that does carry them, creating an asymmetric snapshot
    // where different candidates each rank themselves first on the
    // additions+deletions tiebreaker. Derive ranking fields uniformly from the
    // file inventory (already fetched for every pull) so ranking is
    // deterministic regardless of which REST shape is passed.
    additions,
    deletions,
    changedFiles,
    nodeId: pull.node_id,
    autoMerge: pull.auto_merge,
    headSha: pull.head?.sha,
    headRef: pull.head?.ref,
    ciFiles: ciFilesFor(paths),
    labelNames: labelsOf(pull),
    raw: pull,
    green: false,
  };
}

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function isTrustedRecoveryComment(comment, trustedAppId) {
  if (!comment) return false;
  const authorLogin = String(comment.user?.login || '').toLowerCase();
  const authorAssociation = String(comment.author_association ?? '').toUpperCase();
  return (
    Number(comment.performed_via_github_app?.id) === trustedAppId ||
    TRUSTED_ASSOCIATIONS.has(authorAssociation) ||
    TRUSTED_BOT_LOGINS.has(authorLogin)
  );
}

function singleManagedComment(
  comments,
  marker,
  parser,
  number,
  trustedAppId,
  { requireCoordinatorApp = false, requireTrustedAuthor = false } = {},
) {
  const matching = (comments || []).filter(
    (comment) =>
      String(comment.body || '')
        .trimStart()
        .startsWith(marker) &&
      (!requireCoordinatorApp || Number(comment.performed_via_github_app?.id) === trustedAppId) &&
      (!requireTrustedAuthor || isTrustedRecoveryComment(comment, trustedAppId)),
  );
  if (matching.length > 1) {
    throw new Error(`PR #${number} has duplicate managed comments for ${marker}`);
  }
  return matching[0] ? { comment: matching[0], state: parser(matching[0].body) } : null;
}

function recoveryContext(pull, comments, trustedAppId, now) {
  const managed = singleManagedComment(
    comments,
    RECOVERY_STATE_MARKER,
    parseStateComment,
    pull.number,
    trustedAppId,
    { requireTrustedAuthor: true },
  );
  const state = managed?.state || null;
  let ownershipError = null;
  try {
    assertOwnershipInvariant({
      labelExists: pull.labelNames.has(`ci-owner-pr-${pull.number}`),
      state,
    });
  } catch (error) {
    ownershipError = error.message;
  }
  return {
    state,
    ownershipError,
    healthy: state
      ? isHealthyRecoveryOwner({
          prNumber: pull.number,
          state,
          headSha: pull.headSha,
          now,
        })
      : false,
  };
}

async function fetchExactHead(pull, git) {
  const ref = `refs/remotes/merge-train-ci-conflict/pr-${pull.number}`;
  git(['fetch', 'origin', `${pull.headSha}:${ref}`, '--force']);
  const fetched = git(['rev-parse', ref]);
  if (fetched !== pull.headSha) {
    throw new Error(
      `PR #${pull.number} head moved while collecting live CI conflict order proof (expected ${pull.headSha}, got ${fetched})`,
    );
  }
  return { ...pull, ref };
}

export async function ciConflictOrderReasonForPromotion({
  pullRequest,
  baseSha,
  owner,
  repo,
  repository,
  trustedAppId,
  requiredChecks,
  now = new Date(),
  git,
  fetchOpenPulls,
  fetchPullFiles,
  fetchComments,
  fetchCheckRuns,
  fetchClosingIssues = (number) => listClosingIssues(null, owner, repo, number),
  fetchReviews = async () => [],
}) {
  const [currentFiles, currentComments] = await Promise.all([
    fetchPullFiles(pullRequest.number),
    fetchComments(pullRequest.number),
  ]);
  const currentPull = normalizePull(pullRequest, currentFiles);
  const currentState = singleManagedComment(
    currentComments,
    COORDINATOR_MARKER,
    parseCoordinatorComment,
    currentPull.number,
    trustedAppId,
    { requireCoordinatorApp: true },
  )?.state;
  if (currentPull.ciFiles.length === 0 && !currentState) {
    return null;
  }

  const rawOpenPulls = await fetchOpenPulls();
  // Apply the same eligibility filter as the coordinator reconciler: non-draft,
  // same-repository PRs only. External fork PRs could otherwise join the
  // cluster, become the ranked active slot, and permanently block internal
  // merge-train promotion (or cause a git-fetch failure for their SHA).
  const openPulls = rawOpenPulls
    .map((pull) => (pull.number === pullRequest.number ? pullRequest : pull))
    .filter(
      (pull) =>
        !pull.draft &&
        String(pull.head?.repo?.full_name ?? '').toLowerCase() === repository.toLowerCase(),
    );
  // Retain the candidate itself even if the snapshot did not include it
  // (e.g. the fetch page was split across a race).
  if (!openPulls.some((pull) => pull.number === pullRequest.number)) {
    openPulls.push(pullRequest);
  }
  const filesByNumber = new Map([[pullRequest.number, currentFiles]]);
  const commentsByNumber = new Map([[pullRequest.number, currentComments]]);
  const otherPulls = openPulls.filter((pull) => pull.number !== pullRequest.number);
  await mapLimit(otherPulls, 6, async (pull) => {
    filesByNumber.set(pull.number, await fetchPullFiles(pull.number));
  });
  await mapLimit(otherPulls, 4, async (pull) => {
    commentsByNumber.set(pull.number, await fetchComments(pull.number));
  });

  const normalizedPulls = openPulls.map((pull) =>
    normalizePull(pull, filesByNumber.get(pull.number) || []),
  );
  const existingStates = normalizedPulls
    .map(
      (pull) =>
        singleManagedComment(
          commentsByNumber.get(pull.number),
          COORDINATOR_MARKER,
          parseCoordinatorComment,
          pull.number,
          trustedAppId,
          { requireCoordinatorApp: true },
        )?.state,
    )
    .filter(Boolean);
  const discoveredClusters = discoverCoordinationClusters(normalizedPulls, existingStates);
  const groups = mergeCoordinationGroups({
    discoveredClusters,
    existingStates,
    openPulls: normalizedPulls,
  });
  const group = groups.find((candidate) =>
    candidate.pulls.some((pull) => pull.number === pullRequest.number),
  );
  if (!group) return null;

  await mapLimit(group.pulls, 6, async (pull) => {
    pull.green = successfulChecks(await fetchCheckRuns(pull.headSha), requiredChecks);
  });
  const ranked = rankPullRequests(group.pulls);
  const originalHead = git(['rev-parse', 'HEAD']);
  let proofs;
  try {
    const proofEntries = await mapLimit(ranked, 4, async (pull) => fetchExactHead(pull, git));
    const initialProofs = buildSupersessionProofs({
      baseSha,
      entries: proofEntries,
      git,
    });
    const initialSelection = selectCoordination({ rankedPulls: ranked, proofs: initialProofs });
    proofs = initialProofs.map((proof) => bindProofToLeader(proof, initialSelection.leader));
  } finally {
    git(['checkout', '--detach', originalHead]);
    git(['reset', '--hard', originalHead]);
  }
  const selection = selectCoordination({ rankedPulls: ranked, proofs });
  if (!selection.active) {
    return 'ci-conflict coordinator has no active merge slot on current main';
  }

  const recoveryByNumber = new Map(
    group.pulls.map((pull) => [
      pull.number,
      recoveryContext(pull, commentsByNumber.get(pull.number), trustedAppId, now),
    ]),
  );
  const humanApprovalByNumber = new Map(
    await mapLimit(group.pulls, 4, async (pull) => [
      pull.number,
      await resolveHumanApprovalRejection({
        pullRequest: {
          ...pull.raw,
          labels: [...pull.labelNames].map((name) => ({ name })),
          head: { ...(pull.raw.head || {}), ref: pull.headRef },
        },
        closingIssues: await fetchClosingIssues(pull.number),
        comments: commentsByNumber.get(pull.number) || [],
        ownerLogin: owner,
        fetchReviews: () => fetchReviews(pull.number),
      }),
    ]),
  );
  const activeRecovery = recoveryByNumber.get(selection.active.number);
  if (activeRecovery?.ownershipError) {
    return `ci-conflict coordinator active slot #${selection.active.number} has ownership drift`;
  }
  if (activeRecovery?.healthy) {
    return `ci-conflict coordinator active slot #${selection.active.number} is still owned by CI recovery`;
  }
  const activeHumanApproval = humanApprovalByNumber.get(selection.active.number);
  if (activeHumanApproval) {
    return `ci-conflict coordinator active slot #${selection.active.number} is waiting on human approval`;
  }
  if (selection.active.number !== pullRequest.number) {
    return `ci-conflict coordinator currently selects #${selection.active.number}`;
  }

  // Final binding revalidation: re-scan the candidate's live coordination group
  // and ranking immediately before returning success. Any membership, head, or
  // green-status drift fails closed and forces a rebuild.
  const finalOpenPulls = (await fetchOpenPulls()).filter(
    (pull) =>
      !pull.draft &&
      String(pull.head?.repo?.full_name ?? '').toLowerCase() === repository.toLowerCase(),
  );
  if (!finalOpenPulls.some((pull) => pull.number === pullRequest.number)) {
    return `ci-conflict coordinator candidate #${pullRequest.number} disappeared during verification`;
  }
  const finalFilesByNumber = new Map();
  const finalCommentsByNumber = new Map();
  await mapLimit(finalOpenPulls, 6, async (pull) => {
    finalFilesByNumber.set(pull.number, await fetchPullFiles(pull.number));
  });
  await mapLimit(finalOpenPulls, 4, async (pull) => {
    finalCommentsByNumber.set(pull.number, await fetchComments(pull.number));
  });
  const finalNormalizedPulls = finalOpenPulls.map((pull) =>
    normalizePull(pull, finalFilesByNumber.get(pull.number) || []),
  );
  const finalStates = finalNormalizedPulls
    .map(
      (pull) =>
        singleManagedComment(
          finalCommentsByNumber.get(pull.number),
          COORDINATOR_MARKER,
          parseCoordinatorComment,
          pull.number,
          trustedAppId,
          { requireCoordinatorApp: true },
        )?.state,
    )
    .filter(Boolean);
  const finalDiscovered = discoverCoordinationClusters(finalNormalizedPulls, finalStates);
  const finalGroups = mergeCoordinationGroups({
    discoveredClusters: finalDiscovered,
    existingStates: finalStates,
    openPulls: finalNormalizedPulls,
  });
  const finalGroup = finalGroups.find((candidate) =>
    candidate.pulls.some((pull) => pull.number === pullRequest.number),
  );
  if (!finalGroup) {
    return `ci-conflict coordinator candidate #${pullRequest.number} left coordinated groups during verification`;
  }
  const initialMembers = new Set(group.pulls.map((pull) => pull.number));
  const finalMembers = new Set(finalGroup.pulls.map((pull) => pull.number));
  if (
    initialMembers.size !== finalMembers.size ||
    [...initialMembers].some((number) => !finalMembers.has(number))
  ) {
    return 'ci-conflict coordinator group membership changed during verification';
  }
  await mapLimit(finalGroup.pulls, 6, async (pull) => {
    pull.green = successfulChecks(await fetchCheckRuns(pull.headSha), requiredChecks);
  });
  for (const pull of finalGroup.pulls) {
    const prior = group.pulls.find((candidate) => candidate.number === pull.number);
    if (!prior) {
      return 'ci-conflict coordinator group membership changed during verification';
    }
    if (pull.headSha !== prior.headSha) {
      return `ci-conflict coordinator group member #${pull.number} head drifted (was ${prior.headSha}, now ${pull.headSha})`;
    }
    if (pull.green !== prior.green) {
      return `ci-conflict coordinator group member #${pull.number} check status changed during verification`;
    }
  }
  const finalRanked = rankPullRequests(finalGroup.pulls);
  if (finalRanked.length !== ranked.length) {
    return 'ci-conflict coordinator ranking changed during verification';
  }
  for (let index = 0; index < ranked.length; index += 1) {
    if (finalRanked[index].number !== ranked[index].number) {
      return 'ci-conflict coordinator ranking changed during verification';
    }
  }
  return null;
}
