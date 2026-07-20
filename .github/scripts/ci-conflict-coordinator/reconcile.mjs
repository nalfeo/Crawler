import { execFileSync } from 'node:child_process';

import { graphql, paginate, request } from '../ci-recovery/github.mjs';
import {
  assertOwnershipInvariant,
  ownerLabel,
  parseStateComment as parseRecoveryStateComment,
  STATE_MARKER as RECOVERY_STATE_MARKER,
  TRUSTED_ASSOCIATIONS,
  TRUSTED_BOT_LOGINS,
} from '../ci-recovery/state.mjs';
import {
  parseEnabledFlag,
  resolveAdmissionChecks,
  successfulChecks,
} from '../merge-train/state.mjs';
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
  ciFilesFor,
  discoverCoordinationClusters,
  dispatchKey,
  hasHealthyRecoveryOwner,
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

async function addLabel(pull, name) {
  if (pull.labelNames.has(name)) return;
  await request(token, `/repos/${owner}/${repo}/issues/${pull.number}/labels`, {
    method: 'POST',
    body: { labels: [name] },
  });
  pull.labelNames.add(name);
}

async function removeLabel(pull, name) {
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
  const response = await request(
    token,
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  return response.data.check_runs || [];
}

function normalizePull(pull, paths) {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    createdAt: pull.created_at,
    additions: Number(pull.additions || 0),
    deletions: Number(pull.deletions || 0),
    changedFiles: Number(pull.changed_files || paths.length),
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

async function targetHasHealthyOwner(number) {
  const [pull, comments] = await Promise.all([fetchLivePull(number), commentsFor(number)]);
  const normalized = {
    number,
    labelNames: labelsOf(pull),
  };
  const context = recoveryContext(normalized, comments);
  return context.ownershipError || context.healthy;
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
    await request(token, `/repos/${owner}/${repo}/pulls/${proof.number}`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
    // Post-close revalidation: if main or the leader head has shifted between
    // the pre-check reads and the close API call, reopen the PR and let the
    // next coordinator run re-evaluate. GitHub's close endpoint has no CAS, so
    // a concurrent push can silently make the proof stale.
    const [postMain, postTarget, postLeader] = await Promise.all([
      fetchBaseSha(),
      fetchLivePull(proof.number),
      proof.leaderHead ? fetchLivePull(proof.leaderHead.number) : Promise.resolve(null),
    ]);
    const postLeaderSha = postLeader?.head?.sha ?? null;
    const postTargetDrifted =
      postTarget?.head?.sha !== proof.targetHead ||
      postTarget?.base?.ref !== BASE_REF ||
      postTarget?.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase();
    const proofDrifted =
      postMain !== currentMain ||
      postTargetDrifted ||
      (proof.leaderHead && postLeaderSha !== proof.leaderHead.headSha);
    if (proofDrifted) {
      process.stdout.write(`reopen pr=#${proof.number} reason=post-close-proof-drifted\n`);
      try {
        await request(token, `/repos/${owner}/${repo}/pulls/${proof.number}`, {
          method: 'PATCH',
          body: { state: 'open' },
        });
      } catch (reopenError) {
        process.stdout.write(`reopen-failed pr=#${proof.number} error=${reopenError.message}\n`);
      }
      return false;
    }
    process.stdout.write(
      `closed pr=#${proof.number} reason=deterministically-superseded proof=${proof.fingerprint}\n`,
    );
    return true;
  } finally {
    await releaseOwnerFence(ownerFence);
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
const managedNumbers = pulls
  .filter((pull) => pull.labelNames.has(COORDINATED_LABEL))
  .map((pull) => pull.number);
const stateCandidateNumbers = [
  ...new Set([
    ...managedNumbers,
    ...pulls.filter((pull) => pull.ciFiles.length > 0).map((pull) => pull.number),
  ]),
];
const commentEntries = await mapLimit(stateCandidateNumbers, 8, async (number) => [
  number,
  await commentsFor(number),
]);
const commentsByNumber = new Map(commentEntries);
const existingStates = [];
const existingStateByNumber = new Map();
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
    existingStateByNumber.set(number, managed.state);
  }
}

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
  if (groupedNumbers.has(number) || existingStateByNumber.has(number)) continue;
  const pull = pullByNumber.get(number);
  if (!pull) continue;
  await removeLabel(pull, ORDER_WAIT_LABEL);
  await removeLabel(pull, COORDINATED_LABEL);
  await removeLabel(pull, LEADER_LABEL);
  await removeLabel(pull, ESCALATION_LABEL);
  process.stdout.write(`released orphaned coordinator labels pr=#${number} reason=missing-state\n`);
}
const mainSha = (await request(token, `/repos/${owner}/${repo}/git/ref/heads/main`)).data.object
  .sha;
git(['fetch', 'origin', `${mainSha}:refs/remotes/origin/main`, '--force']);
if (git(['rev-parse', 'refs/remotes/origin/main']) !== mainSha) {
  throw new Error('Fetched main does not match the API-observed main SHA');
}

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
  const ranked = rankPullRequests(group.pulls);
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
  const escalations = [];
  for (const pull of group.pulls) {
    const proof = proofByNumber.get(pull.number);
    const recovery = recoveryByNumber.get(pull.number);
    if (proof?.status === 'ambiguous') {
      escalations.push(`#${pull.number}: ${proof.reason}`);
    }
    if (recovery.ownershipError) {
      escalations.push(`#${pull.number}: ${recovery.ownershipError}`);
    } else if (recovery.healthy && pull.number !== selection.active?.number) {
      escalations.push(`#${pull.number}: active CI recovery owner retained; no close or dispatch`);
    }
  }

  const activeRecovery = selection.active ? recoveryByNumber.get(selection.active.number) : null;
  const activeSafe = selection.active && !activeRecovery?.ownershipError;

  // Fence every member before exposing one slot, so concurrent train runs can
  // observe zero active slots briefly but never two.
  for (const pull of group.pulls) {
    await addLabel(pull, COORDINATED_LABEL);
    await addLabel(pull, ORDER_WAIT_LABEL);
    await disableAutoMerge(pull);
    if (pull.number === selection.leader?.number) await addLabel(pull, LEADER_LABEL);
    else await removeLabel(pull, LEADER_LABEL);
    const escalated =
      proofByNumber.get(pull.number)?.status === 'ambiguous' ||
      Boolean(recoveryByNumber.get(pull.number)?.ownershipError) ||
      (recoveryByNumber.get(pull.number)?.healthy && pull.number !== selection.active?.number);
    if (escalated) await addLabel(pull, ESCALATION_LABEL);
    else await removeLabel(pull, ESCALATION_LABEL);
  }
  if (activeSafe) await removeLabel(selection.active, ORDER_WAIT_LABEL);

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
  const nextDispatchKey = dispatchKey({
    groupId: group.groupId,
    active: activeSafe ? selection.active : null,
    baseSha: mainSha,
    order: selection.ordered,
  });
  if (
    activeSafe &&
    shouldDispatchActiveSlot({
      recoveryState: activeRecovery.state,
      headSha: selection.active.headSha,
      prNumber: selection.active.number,
      priorDispatchKey: lastDispatchKey,
      nextKey: nextDispatchKey,
      now,
    })
  ) {
    await dispatchRecovery(selection.active, group.groupId);
    lastDispatchKey = nextDispatchKey;
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
      activeNumber: activeSafe ? selection.active.number : null,
      order: selection.ordered,
      proofs,
      overlapFiles,
      escalations,
      lastDispatchKey,
      updatedAt: now.toISOString(),
    });
    await updateCoordinatorComment(pull, groupComments.get(pull.number), state);
  }

  for (const duplicate of selection.duplicates) {
    const recovery = recoveryByNumber.get(duplicate.number);
    if (recovery.healthy || recovery.ownershipError) continue;
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
