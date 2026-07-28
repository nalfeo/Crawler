import { execFileSync } from 'node:child_process';

import { graphql, listClosingIssues, paginate, request } from '../ci-recovery/github.mjs';
import {
  assertOwnershipInvariant,
  ownerLabel,
  parseStateComment as parseRecoveryStateComment,
  STATE_MARKER as RECOVERY_STATE_MARKER,
  TRUSTED_ASSOCIATIONS,
  TRUSTED_BOT_LOGINS,
} from '../ci-recovery/state.mjs';
import {
  applyRawLabelDecision,
  formatRawLabelOutcome,
  LIFECYCLE_MARKER,
  nonBlockingPhases,
  parseLifecycleComment,
} from '../ci-recovery/pr-lifecycle.mjs';
import {
  parseEnabledFlag,
  resolveAdmissionChecks,
  successfulChecks,
} from '../merge-train/state.mjs';
import { humanApprovalRejection } from '../merge-train/human-approval.mjs';
import {
  bindProofToLeader,
  buildSupersessionProofs,
  duplicateProofStillMatches,
} from './proof.mjs';
import {
  COORDINATED_LABEL,
  COORDINATOR_MARKER,
  ESCALATION_LABEL,
  LEADER_LABEL,
  ORDER_WAIT_LABEL,
  changeStatsFromFiles,
  ciFilesFor,
  coordinationEnforcementEnabled,
  discoverCoordinationClusters,
  dispatchKey,
  hasHealthyRecoveryOwner,
  hasHealthyShepherdLease,
  isCoordinatorStateSemanticallyEqual,
  makeCoordinatorState,
  mergeCoordinationGroups,
  overlappingFiles,
  parseCoordinatorComment,
  rankPullRequests,
  renderCoordinatorComment,
  selectCoordination,
  shouldDispatchActiveSlot,
} from './state.mjs';

const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const token = process.env.CI_CONFLICT_COORDINATOR_TOKEN || '';
const dispatchToken = process.env.GITHUB_TOKEN || '';
const trustedAppId = Number.parseInt(process.env.CI_CONFLICT_COORDINATOR_APP_ID || '', 10);
const enabled = parseEnabledFlag(process.env.MERGE_TRAIN_ENABLED);
const requiredChecks = resolveAdmissionChecks(process.env.MERGE_TRAIN_ADMISSION_CHECKS);
const REOPEN_RETRY_DELAY_MS = Number(process.env.CI_CONFLICT_REOPEN_RETRY_DELAY_MS ?? 500);
const now = new Date();
const BASE_REF = 'main';

if (!owner || !repo || !token || !dispatchToken || !Number.isInteger(trustedAppId)) {
  throw new Error(
    'CI conflict coordinator requires GITHUB_REPOSITORY, CI_CONFLICT_COORDINATOR_TOKEN, CI_CONFLICT_COORDINATOR_APP_ID, and GITHUB_TOKEN',
  );
}
if (!enabled) {
  process.stdout.write('CI conflict coordinator is disabled because merge train is disabled\n');
  process.exit(0);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env || {}) },
  }).trim();
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

function labelsOf(pull) {
  return new Set((pull.labels || []).map((label) => label.name));
}

async function ensureLabel(name, color, description) {
  try {
    await request(token, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: { name, color, description },
    });
  } catch (error) {
    if (error.status !== 422) throw error;
  }
}

async function githubAddLabel(pull, name) {
  if (pull.labelNames.has(name)) return;
  await request(token, `/repos/${owner}/${repo}/issues/${pull.number}/labels`, {
    method: 'POST',
    body: { labels: [name] },
  });
  pull.labelNames.add(name);
}

async function githubRemoveLabel(pull, name) {
  if (!pull.labelNames.has(name)) return;
  try {
    await request(
      token,
      `/repos/${owner}/${repo}/issues/${pull.number}/labels/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  pull.labelNames.delete(name);
}

// The coordinator never writes phase labels on its own authority. Every
// coordinator-label mutation is expressed as a raw-label decision descriptor
// (applyRawLabelDecision) logged with an explicit acted-vs-no-op signal.
// Coordinator fence labels (COORDINATED_LABEL, LEADER_LABEL, ORDER_WAIT_LABEL,
// ESCALATION_LABEL) are sub-phase signals, not lifecycle phase transitions; they
// do not update the lifecycle comment so the lifecycle record remains coherent.
async function applyCoordinatorLabel(pull, name, desired, reason = 'coordination') {
  const outcome = await applyRawLabelDecision({
    prNumber: pull.number,
    label: name,
    desired,
    currentlyPresent: pull.labelNames.has(name),
    addLabel: () => githubAddLabel(pull, name),
    removeLabel: () => githubRemoveLabel(pull, name),
  });
  process.stdout.write(`${formatRawLabelOutcome(pull.number, outcome)} action=${reason}\n`);
  return outcome;
}

function addLabel(pull, name) {
  return applyCoordinatorLabel(pull, name, true);
}

function removeLabel(pull, name) {
  return applyCoordinatorLabel(pull, name, false);
}

async function disableAutoMerge(pull) {
  if (!pull.autoMerge) return;
  await graphql(
    token,
    `
      mutation ($pullRequestId: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            autoMergeRequest {
              enabledAt
            }
          }
        }
      }
    `,
    { pullRequestId: pull.nodeId },
  );
  pull.autoMerge = null;
}

async function commentsFor(number) {
  return paginate(token, `/repos/${owner}/${repo}/issues/${number}/comments`);
}

function isTrustedRecoveryComment(comment) {
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
  { requireCoordinatorApp = false, requireTrustedAuthor = false } = {},
) {
  const matching = comments.filter(
    (comment) =>
      String(comment.body || '')
        .trimStart()
        .startsWith(marker) &&
      (!requireCoordinatorApp || Number(comment.performed_via_github_app?.id) === trustedAppId) &&
      (!requireTrustedAuthor || isTrustedRecoveryComment(comment)),
  );
  if (matching.length > 1) {
    throw new Error(`PR #${number} has duplicate managed comments for ${marker}`);
  }
  return matching[0] ? { comment: matching[0], state: parser(matching[0].body) } : null;
}

/**
 * Read the authoritative lifecycle phase from a PR's comments.
 * Returns null when no trusted lifecycle comment exists (pre-Issue-8 PRs).
 * Fails closed on duplicates (returns null, logs warning) and on malformed
 * trusted comments (returns null, logs error).
 * Trust boundary: only GitHub Apps, org members, and collaborators can write
 * authoritative lifecycle comments.
 */
function readLifecyclePhase(number, comments) {
  const isTrustedLifecycleAuthor = (comment) => {
    if (!comment) return false;
    if (comment.performed_via_github_app != null) return true;
    return isTrustedRecoveryComment(comment);
  };
  const trusted = comments.filter(
    (comment) =>
      String(comment.body || '')
        .trimStart()
        .startsWith(LIFECYCLE_MARKER) && isTrustedLifecycleAuthor(comment),
  );
  if (trusted.length > 1) {
    process.stdout.write(`lifecycle-comment-duplicate pr=#${number} count=${trusted.length}\n`);
    return null;
  }
  if (trusted.length === 0) return null;
  try {
    const record = parseLifecycleComment(trusted[0].body);
    return record?.phase ?? null;
  } catch {
    process.stdout.write(`lifecycle-comment-parse-error pr=#${number}\n`);
    return null;
  }
}

function recoveryContext(pull, comments) {
  const managed = singleManagedComment(
    comments,
    RECOVERY_STATE_MARKER,
    parseRecoveryStateComment,
    pull.number,
    { requireTrustedAuthor: true },
  );
  const state = managed?.state || null;
  let ownershipError = null;
  try {
    assertOwnershipInvariant({
      labelExists: pull.labelNames.has(ownerLabel(pull.number)),
      state,
    });
  } catch (error) {
    ownershipError = error.message;
  }
  return {
    state,
    ownershipError,
    healthy: state
      ? hasHealthyRecoveryOwner({
          prNumber: pull.number,
          recoveryState: state,
          headSha: pull.headSha,
          now,
        })
      : false,
    // Distinct from `healthy`: only a live shepherd lease may fence the active
    // slot or raise an escalation. Routine automation ownership must not — the
    // coordinator dispatches that automation itself. See issue #2095.
    shepherdLease: state
      ? hasHealthyShepherdLease({ prNumber: pull.number, recoveryState: state, now })
      : false,
  };
}

async function updateCoordinatorComment(pull, comments, state) {
  const managed = singleManagedComment(
    comments,
    COORDINATOR_MARKER,
    parseCoordinatorComment,
    pull.number,
    { requireCoordinatorApp: true },
  );
  if (managed && isCoordinatorStateSemanticallyEqual(managed.state, state)) return;
  const body = renderCoordinatorComment(state);
  if (managed) {
    await request(token, `/repos/${owner}/${repo}/issues/comments/${managed.comment.id}`, {
      method: 'PATCH',
      body: { body },
    });
  } else {
    await request(token, `/repos/${owner}/${repo}/issues/${pull.number}/comments`, {
      method: 'POST',
      body: { body },
    });
  }
}

async function checkRunsFor(sha) {
  const encodedSha = encodeURIComponent(sha);
  const results = [];
  let page = 1;
  while (true) {
    const response = await request(
      token,
      `/repos/${owner}/${repo}/commits/${encodedSha}/check-runs?filter=all&per_page=100&page=${page}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    const runs = response.data.check_runs || [];
    results.push(...runs);
    if (runs.length < 100) return results;
    page += 1;
  }
}

function normalizePull(pull, paths) {
  const { additions, deletions, changedFiles } = changeStatsFromFiles(paths);
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    createdAt: pull.created_at,
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

async function fetchExactHead(pull) {
  const ref = `refs/remotes/ci-conflict/pr-${pull.number}`;
  git(['fetch', 'origin', `${pull.headSha}:${ref}`, '--force']);
  const fetched = git(['rev-parse', ref]);
  if (fetched !== pull.headSha) {
    throw new Error(
      `PR #${pull.number} head moved while collecting proof (expected ${pull.headSha}, got ${fetched})`,
    );
  }
  return { ...pull, ref };
}

async function dispatchRecovery(pull, groupId) {
  await request(
    dispatchToken,
    `/repos/${owner}/${repo}/actions/workflows/ci-recovery.yml/dispatches`,
    {
      method: 'POST',
      body: {
        ref: 'main',
        inputs: {
          operation: 'reconcile',
          pr_number: String(pull.number),
          trigger: `ci-conflict-coordinator:${groupId}`,
          expected_head_sha: pull.headSha,
          expected_base_ref: 'main',
          lease_id: '',
        },
      },
    },
  );
}

async function fetchLivePull(number) {
  return (await request(token, `/repos/${owner}/${repo}/pulls/${number}`)).data;
}

async function fetchBaseSha() {
  return (await request(token, `/repos/${owner}/${repo}/git/ref/heads/${BASE_REF}`)).data.object
    .sha;
}

function livePullMatchesSelectionBinding(pull, livePull) {
  return (
    Boolean(livePull) &&
    livePull.state === 'open' &&
    !livePull.draft &&
    livePull.base?.ref === BASE_REF &&
    livePull.head?.sha === pull.headSha &&
    livePull.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
    (!pull.headRef || livePull.head?.ref === pull.headRef)
  );
}

async function selectionBindingsStillMatch(pulls, mainSha) {
  const currentMain = await fetchBaseSha();
  if (currentMain !== mainSha) {
    return {
      matches: false,
      reason: `selection bindings drifted: main advanced from ${mainSha} to ${currentMain}`,
    };
  }
  const livePullEntries = await mapLimit(pulls, 4, async (pull) => [
    pull.number,
    await fetchLivePull(pull.number),
  ]);
  const livePulls = new Map(livePullEntries);
  for (const pull of pulls) {
    const livePull = livePulls.get(pull.number);
    if (livePullMatchesSelectionBinding(pull, livePull)) continue;
    return {
      matches: false,
      reason:
        `selection bindings drifted: pr=#${pull.number} expected head=${pull.headSha}` +
        `${pull.headRef ? ` ref=${pull.headRef}` : ''} got head=${livePull?.head?.sha ?? 'missing'}` +
        `${livePull?.head?.ref ? ` ref=${livePull.head.ref}` : ''}`,
    };
  }
  return { matches: true };
}

async function targetHasHealthyOwner(number) {
  const [pull, comments] = await Promise.all([fetchLivePull(number), commentsFor(number)]);
  const normalized = {
    number,
    labelNames: labelsOf(pull),
    headSha: pull.head?.sha,
  };
  const context = recoveryContext(normalized, comments);
  return context.ownershipError || context.healthy;
}

async function liveHumanApprovalRejection(
  number,
  { pull = null, comments = null, closingIssues = null } = {},
) {
  const livePull = pull || (await fetchLivePull(number));
  const [liveComments, liveClosingIssues] = await Promise.all([
    comments ? Promise.resolve(comments) : commentsFor(number),
    closingIssues ? Promise.resolve(closingIssues) : listClosingIssues(token, owner, repo, number),
  ]);
  return humanApprovalRejection({
    pullRequest: livePull,
    closingIssues: liveClosingIssues,
    comments: liveComments,
    ownerLogin: owner,
  });
}

async function claimOwnerFence(number) {
  const labelName = ownerLabel(number);
  try {
    const created = await request(token, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: {
        name: labelName,
        color: '0969da',
        description: `CI recovery ownership for PR #${number}`,
      },
    });
    return {
      claimed: true,
      name: labelName,
      nodeId: created.data?.node_id || null,
    };
  } catch (error) {
    if (error.status !== 422) throw error;
    return { claimed: false, name: labelName, nodeId: null };
  }
}

async function releaseOwnerFence(fence) {
  if (!fence?.claimed) return;
  try {
    await request(token, `/repos/${owner}/${repo}/labels/${encodeURIComponent(fence.name)}`, {
      method: 'DELETE',
    });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function closeDuplicate(proof) {
  const ownerFence = await claimOwnerFence(proof.number);
  if (!ownerFence.claimed) {
    process.stdout.write(`retain pr=#${proof.number} reason=owner-fence-busy\n`);
    return false;
  }
  try {
    if (await targetHasHealthyOwner(proof.number)) {
      process.stdout.write(`retain pr=#${proof.number} reason=healthy-or-inconsistent-owner\n`);
      return false;
    }
    const currentMain = await fetchBaseSha();
    const numbers = new Set([
      proof.number,
      ...proof.predecessorHeads.map(({ number }) => number),
      ...(proof.leaderHead ? [proof.leaderHead.number] : []),
    ]);
    const pulls = await mapLimit([...numbers], 4, async (number) => [
      number,
      await fetchLivePull(number),
    ]);
    if (
      !duplicateProofStillMatches({
        proof,
        mainSha: currentMain,
        livePulls: new Map(pulls),
        repository,
      })
    ) {
      process.stdout.write(`retain pr=#${proof.number} reason=supersession-proof-drifted\n`);
      return false;
    }
    const liveTargetForApproval = await fetchLivePull(proof.number);
    const approvalRejection = await liveHumanApprovalRejection(proof.number, {
      pull: liveTargetForApproval,
    });
    if (approvalRejection) {
      process.stdout.write(`retain pr=#${proof.number} reason=human-approval-required\n`);
      return false;
    }

    let closeRequestError = null;
    try {
      await request(token, `/repos/${owner}/${repo}/pulls/${proof.number}`, {
        method: 'PATCH',
        body: { state: 'closed' },
      });
    } catch (error) {
      closeRequestError = error;
      let postErrorPull = null;
      try {
        postErrorPull = await fetchLivePull(proof.number);
      } catch (readError) {
        // Close may have applied even though the response failed. Continue into
        // the post-close reopen safety flow and mark reads as unverifiable.
        process.stdout.write(
          `warn: close response for PR #${proof.number} failed and post-error state read failed: ${readError.message}\n`,
        );
      }
      if (postErrorPull && postErrorPull.state !== 'closed') {
        throw error;
      }
    }
    // Post-close revalidation: if main or the leader head has shifted between
    // the pre-check reads and the close API call, reopen the PR and let the
    // next coordinator run re-evaluate. GitHub's close endpoint has no CAS, so
    // a concurrent push can silently make the proof stale. Treat any failed
    // post-close read as equally unsafe: the PR is already closed, and without
    // a confirmed reopen it would disappear from future coordinator discovery.
    let postCloseReopenReason = null;
    let postCloseUnsafeContext = closeRequestError
      ? `post-close proof revalidation after ambiguous close failed: ${closeRequestError.message}`
      : 'post-close proof drift';
    try {
      const [postMain, postTarget, postLeader, postComments, postClosingIssues] = await Promise.all(
        [
          fetchBaseSha(),
          fetchLivePull(proof.number),
          proof.leaderHead ? fetchLivePull(proof.leaderHead.number) : Promise.resolve(null),
          commentsFor(proof.number),
          listClosingIssues(token, owner, repo, proof.number),
        ],
      );
      const postLeaderSha = postLeader?.head?.sha ?? null;
      const postTargetDrifted =
        postTarget?.head?.sha !== proof.targetHead ||
        postTarget?.base?.ref !== BASE_REF ||
        postTarget?.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase();
      const postApprovalRejection = await liveHumanApprovalRejection(proof.number, {
        pull: postTarget,
        comments: postComments,
        closingIssues: postClosingIssues,
      });
      const proofDrifted =
        postMain !== currentMain ||
        postTargetDrifted ||
        (proof.leaderHead && postLeaderSha !== proof.leaderHead.headSha);
      if (!postCloseReopenReason && postApprovalRejection) {
        postCloseReopenReason = 'post-close-human-approval-required';
      }
      if (proofDrifted) {
        postCloseReopenReason = 'post-close-proof-drifted';
      }
    } catch (error) {
      postCloseReopenReason = 'post-close-proof-unverifiable';
      postCloseUnsafeContext = `post-close proof revalidation failed: ${error.message}`;
    }
    if (postCloseReopenReason) {
      process.stdout.write(`reopen pr=#${proof.number} reason=${postCloseReopenReason}\n`);
      const MAX_REOPEN_ATTEMPTS = 3;
      let lastReopenError = null;
      for (let attempt = 0; attempt < MAX_REOPEN_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, REOPEN_RETRY_DELAY_MS * attempt));
        }
        try {
          await request(token, `/repos/${owner}/${repo}/pulls/${proof.number}`, {
            method: 'PATCH',
            body: { state: 'open' },
          });
          lastReopenError = null;
          break;
        } catch (err) {
          lastReopenError = err;
          process.stdout.write(
            `reopen-attempt-failed pr=#${proof.number} attempt=${attempt + 1} error=${err.message}\n`,
          );
        }
      }
      if (lastReopenError) {
        // Reopen could not be confirmed after all attempts. The PR was closed
        // but its branch has since diverged, so leaving it closed is unsafe.
        // Closed PRs are excluded from subsequent coordinator discovery, so
        // the backstop cron cannot repair this automatically. Throw so the
        // workflow fails and surfaces in CI for manual intervention.
        throw new Error(
          `UNSAFE: failed to reopen PR #${proof.number} after ${postCloseUnsafeContext} ` +
            `(${MAX_REOPEN_ATTEMPTS} attempts exhausted); manual intervention required. ` +
            `Last error: ${lastReopenError.message}`,
        );
      }
      return false;
    }
    process.stdout.write(
      `closed pr=#${proof.number} reason=deterministically-superseded proof=${proof.fingerprint}\n`,
    );
    return true;
  } finally {
    try {
      await releaseOwnerFence(ownerFence);
    } catch (releaseError) {
      process.stdout.write(
        `warn: owner-fence release failed for PR #${proof.number}: ${releaseError.message} (fence may need manual cleanup)\n`,
      );
    }
  }
}

await Promise.all([
  ensureLabel(COORDINATED_LABEL, '8250df', 'PR belongs to a coordinated CI conflict cluster'),
  ensureLabel(LEADER_LABEL, '1f6feb', 'Canonical leader for a coordinated CI conflict cluster'),
  ensureLabel(ESCALATION_LABEL, 'd1242f', 'CI conflict overlap requires maintainer resolution'),
  ensureLabel(ORDER_WAIT_LABEL, 'fbca04', 'Waiting for an earlier coordinated merge-train slot'),
]);

const openPulls = await paginate(token, `/repos/${owner}/${repo}/pulls?state=open`);
const eligible = openPulls.filter(
  (pull) =>
    !pull.draft &&
    pull.base?.ref === 'main' &&
    pull.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase(),
);
const fileLists = await mapLimit(eligible, 8, async (pull) => {
  const files = await paginate(token, `/repos/${owner}/${repo}/pulls/${pull.number}/files`);
  return [
    ...new Set(files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean))),
  ];
});
const pulls = eligible.map((pull, index) => normalizePull(pull, fileLists[index]));
const coordinatorLabels = [COORDINATED_LABEL, LEADER_LABEL, ESCALATION_LABEL, ORDER_WAIT_LABEL];
const labeledManagedNumbers = pulls
  .filter((pull) => coordinatorLabels.some((label) => pull.labelNames.has(label)))
  .map((pull) => pull.number);
const stateCandidateNumbers = [
  ...new Set([
    ...labeledManagedNumbers,
    ...pulls.filter((pull) => pull.ciFiles.length > 0).map((pull) => pull.number),
  ]),
];
const commentEntries = await mapLimit(stateCandidateNumbers, 8, async (number) => [
  number,
  await commentsFor(number),
]);
const commentsByNumber = new Map(commentEntries);
const existingStates = [];
const commentedManagedNumbers = [];
// Track coordinator comment ids so dissolved groups can have their durable
// comment deleted (not just label-stripped) during out-of-scope cleanup below.
const coordinatorCommentIdByNumber = new Map();
for (const [number, comments] of commentEntries) {
  const managed = singleManagedComment(
    comments,
    COORDINATOR_MARKER,
    parseCoordinatorComment,
    number,
    { requireCoordinatorApp: true },
  );
  if (managed) {
    existingStates.push(managed.state);
    commentedManagedNumbers.push(number);
    coordinatorCommentIdByNumber.set(number, managed.comment.id);
  }
}
const managedNumbers = [...new Set([...labeledManagedNumbers, ...commentedManagedNumbers])];

const discoveredClusters = discoverCoordinationClusters(pulls, existingStates);
const discoveredNumbers = new Set(discoveredClusters.flat().map((pull) => pull.number));
const relevantNumbers = [...new Set([...discoveredNumbers, ...managedNumbers])];
if (relevantNumbers.length === 0) {
  process.stdout.write('No CI conflict clusters found\n');
  process.exit(0);
}

const groups = mergeCoordinationGroups({
  discoveredClusters,
  existingStates,
  openPulls: pulls,
});
const pullByNumber = new Map(pulls.map((pull) => [pull.number, pull]));
const groupedNumbers = new Set(groups.flatMap((group) => group.pulls.map((pull) => pull.number)));
for (const number of managedNumbers) {
  if (groupedNumbers.has(number)) continue;
  const pull = pullByNumber.get(number);
  if (!pull) continue;
  await removeLabel(pull, ORDER_WAIT_LABEL);
  await removeLabel(pull, COORDINATED_LABEL);
  await removeLabel(pull, LEADER_LABEL);
  await removeLabel(pull, ESCALATION_LABEL);
  process.stdout.write(
    `released orphaned coordinator labels pr=#${number} reason=out-of-scope-or-stale\n`,
  );
  // Delete the durable coordinator comment so the stale state blob is not
  // re-parsed on the next sweep and re-queued for indefinite cleanup. Labels
  // are already gone; the comment is the only surviving artifact.
  const commentId = coordinatorCommentIdByNumber.get(number);
  if (commentId) {
    try {
      await request(token, `/repos/${owner}/${repo}/issues/comments/${commentId}`, {
        method: 'DELETE',
      });
      process.stdout.write(
        `deleted coordinator comment pr=#${number} comment_id=${commentId}\n`,
      );
    } catch (error) {
      // Non-fatal: a 404 means it was already deleted; log and continue.
      process.stdout.write(
        `skip coordinator comment delete pr=#${number} comment_id=${commentId} error=${error?.message || error}\n`,
      );
    }
  }
}
if (groups.length === 0) {
  process.stdout.write('No CI conflict clusters found after cleanup\n');
  process.exit(0);
}
const mainSha = (await request(token, `/repos/${owner}/${repo}/git/ref/heads/main`)).data.object
  .sha;
git(['fetch', 'origin', `${mainSha}:refs/remotes/origin/main`, '--force']);
if (git(['rev-parse', 'refs/remotes/origin/main']) !== mainSha) {
  throw new Error('Fetched main does not match the API-observed main SHA');
}

const enforceCoordination = coordinationEnforcementEnabled(process.env);
for (const group of groups) {
  const groupComments = new Map();
  for (const pull of group.pulls) {
    let comments = commentsByNumber.get(pull.number);
    if (!comments) {
      comments = await commentsFor(pull.number);
      commentsByNumber.set(pull.number, comments);
    }
    groupComments.set(pull.number, comments);
  }

  await mapLimit(group.pulls, 6, async (pull) => {
    pull.green = successfulChecks(await checkRunsFor(pull.headSha), requiredChecks);
  });

  // Populate lifecyclePhase on each pull so whoMustLandFirst can structurally
  // exclude quarantined/abandoned PRs from leader and ordering selection (D11).
  for (const pull of group.pulls) {
    pull.lifecyclePhase = readLifecyclePhase(pull.number, groupComments.get(pull.number) || []);
  }

  // Filter out non-blocking (quarantined/abandoned) pulls before ranking and
  // proof collection. A non-blocking PR is never a valid leader or predecessor —
  // whoMustLandFirst enforces this structurally, but filtering at the ranked
  // list prevents proof collection and selectCoordination from touching those
  // PRs entirely (D11 structural guarantee in the coordinator runtime).
  const nbPhases = new Set(nonBlockingPhases());
  const blockingPulls = group.pulls.filter((pull) => !nbPhases.has(pull.lifecyclePhase));
  const enforceCoordination = coordinationEnforcementEnabled(process.env);
  if (blockingPulls.length === 0) {
    const recoveryByNumber = new Map(
      group.pulls.map((pull) => [
        pull.number,
        recoveryContext(pull, groupComments.get(pull.number)),
      ]),
    );
    const humanApprovalByNumber = new Map(
      await mapLimit(group.pulls, 4, async (pull) => [
        pull.number,
        humanApprovalRejection({
          pullRequest: {
            labels: [...pull.labelNames].map((name) => ({ name })),
            head: { ref: pull.headRef },
          },
          closingIssues: await listClosingIssues(token, owner, repo, pull.number),
          comments: groupComments.get(pull.number) || [],
          ownerLogin: owner,
        }),
      ]),
    );

    for (const pull of group.pulls) {
      const ownershipGated =
        Boolean(recoveryByNumber.get(pull.number)?.ownershipError) ||
        Boolean(recoveryByNumber.get(pull.number)?.shepherdLease) ||
        Boolean(humanApprovalByNumber.get(pull.number));
      await removeLabel(pull, ORDER_WAIT_LABEL);
      await removeLabel(pull, COORDINATED_LABEL);
      await removeLabel(pull, LEADER_LABEL);
      if (ownershipGated) {
        await addLabel(pull, ESCALATION_LABEL);
        await disableAutoMerge(pull);
      } else {
        await removeLabel(pull, ESCALATION_LABEL);
      }
    }

    // All pulls in this group are non-blocking (quarantined/abandoned). Nothing to
    // coordinate — skip proof collection and selection for this group entirely.
    //
    // These PRs stay in groupedNumbers, so the orphan-drain loop above never sees
    // them. Reconcile the grouping-derived labels here or they strand forever.
    // ESCALATION_LABEL is deliberately left alone: it can encode a real ownership
    // gate, and this path returns before ownership is evaluated. Removing it would
    // also re-expose the PR to CI-recovery dispatch, which a quarantined/abandoned
    // PR should not receive.
    if (!enforceCoordination) {
      for (const pull of group.pulls) {
        await removeLabel(pull, ORDER_WAIT_LABEL);
        await removeLabel(pull, COORDINATED_LABEL);
        await removeLabel(pull, LEADER_LABEL);
      }
    }
    process.stdout.write(
      `skip group=${group.groupId} reason=all-pulls-non-blocking members=${group.pulls.map((p) => p.number).join(',')}\n`,
    );
    continue;
  }
  const ranked = rankPullRequests(blockingPulls);
  const proofEntries = await mapLimit(ranked, 4, fetchExactHead);
  const initialProofs = buildSupersessionProofs({
    baseSha: mainSha,
    entries: proofEntries,
    git,
  });
  const initialSelection = selectCoordination({ rankedPulls: ranked, proofs: initialProofs });
  const proofs = initialProofs.map((proof) => bindProofToLeader(proof, initialSelection.leader));
  const selection = selectCoordination({ rankedPulls: ranked, proofs });
  const proofByNumber = new Map(proofs.map((proof) => [proof.number, proof]));
  const recoveryByNumber = new Map(
    group.pulls.map((pull) => [pull.number, recoveryContext(pull, groupComments.get(pull.number))]),
  );
  const humanApprovalByNumber = new Map(
    await mapLimit(group.pulls, 4, async (pull) => [
      pull.number,
      humanApprovalRejection({
        pullRequest: {
          labels: [...pull.labelNames].map((name) => ({ name })),
          head: { ref: pull.headRef },
        },
        closingIssues: await listClosingIssues(token, owner, repo, pull.number),
        comments: groupComments.get(pull.number) || [],
        ownerLogin: owner,
      }),
    ]),
  );
  const escalations = [];
  for (const pull of group.pulls) {
    const proof = proofByNumber.get(pull.number);
    const recovery = recoveryByNumber.get(pull.number);
    const humanApproval = humanApprovalByNumber.get(pull.number);
    if (proof?.status === 'ambiguous') {
      escalations.push(`#${pull.number}: ${proof.reason}`);
    }
    if (recovery.ownershipError) {
      escalations.push(`#${pull.number}: ${recovery.ownershipError}`);
    } else if (recovery.shepherdLease) {
      escalations.push(`#${pull.number}: active shepherd lease retained; no close or dispatch`);
    }
    if (humanApproval) {
      escalations.push(`#${pull.number}: ${humanApproval}`);
    }
  }

  const activeRecovery = selection.active ? recoveryByNumber.get(selection.active.number) : null;
  const activeHumanApproval = selection.active
    ? humanApprovalByNumber.get(selection.active.number)
    : null;
  // A healthy shepherd lease on the active slot must keep it fenced: remove
  // ORDER_WAIT only when there is no ownership error, active shepherd, or
  // outstanding repository-owner approval.
  //
  // Routine `automation` ownership is intentionally NOT a fence here. The
  // coordinator dispatches CI recovery for its own active slot, so treating any
  // healthy recovery owner as unsafe made the slot permanently unsafe the
  // instant it was dispatched (issue #2095).
  const activeSafe =
    selection.active &&
    !activeRecovery?.ownershipError &&
    !activeRecovery?.shepherdLease &&
    !activeHumanApproval;

  // Fence every member before exposing one slot, so concurrent train runs can
  // observe zero active slots briefly but never two.
  //
  // With enforcement disabled (the default) we keep discovery/reporting via the
  // coordinator comment, but actively UNFENCE and UNLABEL: ORDER_WAIT,
  // COORDINATED and LEADER are all removed from every member. Removing (rather
  // than merely not-adding) is what drains labels stranded by a previous
  // enforcing run — no manual cleanup pass is needed.
  //
  // SAFETY INVARIANT (independent of the kill switch): auto-merge is ALWAYS
  // disarmed for a PR that a human must approve, that an agent actively owns
  // (shepherd lease), or whose ownership record is corrupt. Those gates are
  // enforced asynchronously by CI recovery / the merge train, so leaving an
  // already-armed auto-merge in place would let GitHub merge the PR the moment
  // its checks pass — before any of those reconcilers next run. Serialization
  // is what we are switching off here; human/agent ownership gates are not.
  for (const pull of group.pulls) {
    const ownershipGated =
      Boolean(recoveryByNumber.get(pull.number)?.ownershipError) ||
      Boolean(recoveryByNumber.get(pull.number)?.shepherdLease) ||
      Boolean(humanApprovalByNumber.get(pull.number));
    if (enforceCoordination) {
      await addLabel(pull, COORDINATED_LABEL);
      await addLabel(pull, ORDER_WAIT_LABEL);
      await disableAutoMerge(pull);
      if (pull.number === selection.leader?.number) await addLabel(pull, LEADER_LABEL);
      else await removeLabel(pull, LEADER_LABEL);
    } else {
      // Unenforced (the default): grouping is advisory only, and the grouping
      // predicate keys on CI-filename identity rather than any real conflict
      // test (issue #2180), so these labels routinely assert conflicts that do
      // not exist. Publishing them marks non-conflicting PRs as conflict-managed
      // and misleads both humans and other reconcilers. Remove (rather than
      // merely not-add) so labels stranded by an earlier enforcing run drain
      // without a manual cleanup pass.
      await removeLabel(pull, ORDER_WAIT_LABEL);
      await removeLabel(pull, COORDINATED_LABEL);
      await removeLabel(pull, LEADER_LABEL);
      if (ownershipGated) await disableAutoMerge(pull);
    }
    // Ownership escalation is a real, grouping-independent signal and is never
    // switched off. An `ambiguous` supersession proof, by contrast, is derived
    // from group-mates, so it only escalates while enforcement is on.
    const escalated =
      ownershipGated ||
      (enforceCoordination && proofByNumber.get(pull.number)?.status === 'ambiguous');
    if (escalated) await addLabel(pull, ESCALATION_LABEL);
    else await removeLabel(pull, ESCALATION_LABEL);
  }
  let activeReady = false;
  let selectionBindingDrift = null;
  if (activeSafe) {
    const bindingCheck = await selectionBindingsStillMatch(group.pulls, mainSha);
    if (bindingCheck.matches) {
      await removeLabel(selection.active, ORDER_WAIT_LABEL);
      activeReady = true;
    } else {
      selectionBindingDrift = bindingCheck.reason;
      escalations.push(bindingCheck.reason);
      // Binding drift is a group-derived signal: it means a group-mate's head
      // moved out from under the selection. With enforcement off there is no
      // fence to protect, so escalating here would re-apply the very label the
      // member loop above just drained (and would withhold CI-recovery dispatch
      // from PRs that are not actually blocked). Keep the reason in `escalations`
      // so the coordinator comment still reports it.
      if (enforceCoordination) {
        for (const pull of group.pulls) {
          await addLabel(pull, ESCALATION_LABEL);
        }
      }
      process.stdout.write(`retain fenced group=${group.groupId} reason=${bindingCheck.reason}\n`);
    }
  }

  const priorStates = group.pulls
    .map(
      (pull) =>
        singleManagedComment(
          groupComments.get(pull.number),
          COORDINATOR_MARKER,
          parseCoordinatorComment,
          pull.number,
          { requireCoordinatorApp: true },
        )?.state,
    )
    .filter(Boolean)
    .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
  let lastDispatchKey = priorStates[0]?.lastDispatchKey || null;
  let lastDispatchAt = priorStates[0]?.lastDispatchAt || null;
  const nextDispatchKey = dispatchKey({
    groupId: group.groupId,
    active: activeReady ? selection.active : null,
    baseSha: mainSha,
    order: selection.ordered,
  });
  if (
    activeReady &&
    shouldDispatchActiveSlot({
      recoveryState: activeRecovery.state,
      headSha: selection.active.headSha,
      prNumber: selection.active.number,
      priorDispatchKey: lastDispatchKey,
      nextKey: nextDispatchKey,
      lastDispatchAt,
      now,
    })
  ) {
    await dispatchRecovery(selection.active, group.groupId);
    lastDispatchKey = nextDispatchKey;
    lastDispatchAt = now.toISOString();
    process.stdout.write(
      `dispatched ci-recovery pr=#${selection.active.number} group=${group.groupId}\n`,
    );
  }

  const overlapFiles = overlappingFiles(group.pulls);
  for (const pull of group.pulls) {
    const state = makeCoordinatorState({
      prNumber: pull.number,
      groupId: group.groupId,
      originalMembers: group.originalMembers,
      leaderNumber: selection.leader.number,
      activeNumber: activeReady ? selection.active.number : null,
      order: selection.ordered,
      proofs,
      overlapFiles,
      escalations,
      lastDispatchKey,
      lastDispatchAt,
      updatedAt: now.toISOString(),
    });
    await updateCoordinatorComment(pull, groupComments.get(pull.number), state);
  }

  for (const duplicate of selection.duplicates) {
    if (selectionBindingDrift) {
      process.stdout.write(`retain pr=#${duplicate.number} reason=selection-binding-drift\n`);
      continue;
    }
    const recovery = recoveryByNumber.get(duplicate.number);
    if (recovery.healthy || recovery.ownershipError) continue;
    if (humanApprovalByNumber.get(duplicate.number)) {
      process.stdout.write(`retain pr=#${duplicate.number} reason=human-approval-required\n`);
      continue;
    }
    const proof = proofByNumber.get(duplicate.number);
    // Only close duplicates that are no-op against current main alone.
    // A proof with open predecessor heads is superseded by the combination of
    // main + still-open predecessor PRs; if a predecessor is later force-pushed
    // or closed without merging, its changes would be permanently lost. Wait
    // until predecessors land on main before closing.
    if (proof.predecessorHeads.length > 0) {
      process.stdout.write(
        `retain pr=#${duplicate.number} reason=predecessor-dependent-supersession\n`,
      );
      continue;
    }
    await closeDuplicate(proof);
  }
}
