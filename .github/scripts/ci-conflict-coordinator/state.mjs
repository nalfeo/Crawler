import { createHash } from 'node:crypto';

import { isHealthyRecoveryOwner } from '../ci-recovery/state.mjs';

export const COORDINATOR_MARKER = '<!-- crawler-ci-conflict-coordinator:v1 -->';
export const COORDINATOR_DATA_PREFIX = '<!-- crawler-ci-conflict-coordinator-data:';
export const COORDINATED_LABEL = 'ci-conflict-coordinated';
export const LEADER_LABEL = 'ci-conflict-leader';
export const ESCALATION_LABEL = 'ci-conflict-escalation';
export const ORDER_WAIT_LABEL = 'ci-conflict-order-wait';
export const MIN_CLUSTER_SIZE = 3;

const CI_PATH_PREFIXES = [
  '.github/actions/',
  '.github/scripts/',
  '.github/workflows/',
  'scripts/agent/',
];

function compact(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedPath(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function isCiCoordinationPath(filePath) {
  const candidate = normalizedPath(filePath);
  return CI_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix));
}

export function ciFilesFor(paths) {
  return [...new Set((paths || []).map(normalizedPath).filter(isCiCoordinationPath))].sort();
}

function overlap(left, right) {
  const rightFiles = new Set(right.ciFiles);
  return left.ciFiles.some((file) => rightFiles.has(file));
}

export function clusterPullRequests(pullRequests, minimumSize = MIN_CLUSTER_SIZE) {
  const candidates = (pullRequests || []).filter(
    (pull) => pull.state === 'open' && !pull.draft && pull.ciFiles.length > 0,
  );
  const parent = candidates.map((_, index) => index);

  function find(index) {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  }

  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  }

  const fileOwners = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    for (const file of candidates[index].ciFiles) {
      const owner = fileOwners.get(file);
      if (owner === undefined) fileOwners.set(file, index);
      else union(index, owner);
    }
  }

  const components = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const root = find(index);
    const component = components.get(root) || [];
    component.push(candidates[index]);
    components.set(root, component);
  }

  return [...components.values()]
    .filter((component) => component.length >= minimumSize)
    .map((component) => component.sort((left, right) => left.number - right.number))
    .sort((left, right) => left[0].number - right[0].number);
}

export function discoverCoordinationClusters(
  pullRequests,
  existingStates,
  minimumSize = MIN_CLUSTER_SIZE,
) {
  const managedMembers = new Set((existingStates || []).flatMap((state) => state.members || []));
  return clusterPullRequests(pullRequests, 1).filter(
    (component) =>
      component.length >= minimumSize || component.some((pull) => managedMembers.has(pull.number)),
  );
}

export function overlappingFiles(pullRequests) {
  const counts = new Map();
  for (const pull of pullRequests || []) {
    for (const file of pull.ciFiles) counts.set(file, (counts.get(file) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([file]) => file)
    .sort();
}

export function rankPullRequests(pullRequests) {
  return [...(pullRequests || [])].sort(
    (left, right) =>
      Number(Boolean(right.green)) - Number(Boolean(left.green)) ||
      right.ciFiles.length - left.ciFiles.length ||
      Number(right.changedFiles || 0) - Number(left.changedFiles || 0) ||
      Number(right.additions || 0) +
        Number(right.deletions || 0) -
        (Number(left.additions || 0) + Number(left.deletions || 0)) ||
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
      left.number - right.number,
  );
}

export function groupIdFor(numbers) {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  return `ci-conflict-${hash(sorted).slice(0, 16)}`;
}

export function mergeCoordinationGroups({ discoveredClusters, existingStates, openPulls }) {
  const openByNumber = new Map(openPulls.map((pull) => [pull.number, pull]));
  const seeds = [];

  for (const cluster of discoveredClusters) {
    seeds.push({
      numbers: new Set(cluster.map((pull) => pull.number)),
      groupIds: new Set(),
      originalMembers: new Set(cluster.map((pull) => pull.number)),
      qualified: true,
    });
  }

  for (const state of existingStates) {
    const openMembers = state.members.filter((number) => openByNumber.has(number));
    if (state.originalSize < MIN_CLUSTER_SIZE || openMembers.length === 0) continue;
    seeds.push({
      numbers: new Set(openMembers),
      groupIds: new Set([state.groupId]),
      originalMembers: new Set(state.members),
      qualified: true,
    });
  }

  let merged = seeds;
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const seed of merged) {
      const matches = next.filter((candidate) =>
        [...seed.numbers].some((number) => candidate.numbers.has(number)),
      );
      if (matches.length === 0) {
        next.push(seed);
        continue;
      }
      const target = matches[0];
      for (const number of seed.numbers) target.numbers.add(number);
      for (const groupId of seed.groupIds) target.groupIds.add(groupId);
      for (const number of seed.originalMembers) target.originalMembers.add(number);
      for (const extra of matches.slice(1)) {
        for (const number of extra.numbers) target.numbers.add(number);
        for (const groupId of extra.groupIds) target.groupIds.add(groupId);
        for (const number of extra.originalMembers) target.originalMembers.add(number);
        next.splice(next.indexOf(extra), 1);
      }
      changed = true;
    }
    merged = next;
  }

  return merged
    .map((group) => {
      const pulls = [...group.numbers]
        .map((number) => openByNumber.get(number))
        .filter(Boolean)
        .sort((left, right) => left.number - right.number);
      const originalMembers = [...group.originalMembers].sort((left, right) => left - right);
      return {
        groupId:
          [...group.groupIds].sort()[0] || groupIdFor(originalMembers.map(Number).filter(Boolean)),
        pulls,
        originalMembers,
      };
    })
    .filter((group) => group.pulls.length > 0)
    .sort((left, right) => left.groupId.localeCompare(right.groupId));
}

export function proofFingerprint({ baseSha, predecessorHeads, targetHead, leaderHead = null }) {
  return hash({
    baseSha: compact(baseSha),
    predecessorHeads: (predecessorHeads || []).map(({ number, headSha }) => ({
      number,
      headSha: compact(headSha),
    })),
    targetHead: compact(targetHead),
    leaderHead: leaderHead
      ? { number: leaderHead.number, headSha: compact(leaderHead.headSha) }
      : null,
  });
}

export function selectCoordination({ rankedPulls, proofs }) {
  const proofByNumber = new Map(proofs.map((proof) => [proof.number, proof]));
  const ordered = rankedPulls.filter(
    (pull) => proofByNumber.get(pull.number)?.status !== 'superseded',
  );
  const leader = ordered[0] || rankedPulls[0] || null;
  const active =
    ordered[0] && proofByNumber.get(ordered[0].number)?.status === 'applied' ? ordered[0] : null;
  const duplicates = rankedPulls.filter(
    (pull) => proofByNumber.get(pull.number)?.status === 'superseded',
  );
  const ambiguous = rankedPulls.filter(
    (pull) => proofByNumber.get(pull.number)?.status === 'ambiguous',
  );
  return { leader, active, ordered, duplicates, ambiguous };
}

export function dispatchKey({ groupId, active, baseSha, order }) {
  if (!active) return null;
  return hash({
    groupId,
    active: { number: active.number, headSha: active.headSha },
    baseSha,
    order: order.map((pull) => ({ number: pull.number, headSha: pull.headSha })),
  });
}

export function hasHealthyRecoveryOwner({ prNumber, recoveryState, headSha, now }) {
  return isHealthyRecoveryOwner({ prNumber, state: recoveryState, headSha, now });
}

export function shouldDispatchActiveSlot({
  recoveryState,
  headSha,
  prNumber,
  priorDispatchKey,
  nextKey,
  now,
}) {
  if (!nextKey || priorDispatchKey === nextKey) return false;
  return !hasHealthyRecoveryOwner({ prNumber, recoveryState, headSha, now });
}

export function makeCoordinatorState({
  prNumber,
  groupId,
  originalMembers,
  leaderNumber,
  activeNumber,
  order,
  proofs,
  overlapFiles,
  escalations = [],
  lastDispatchKey = null,
  updatedAt,
}) {
  const state = {
    version: 1,
    prNumber,
    groupId: compact(groupId),
    originalSize: originalMembers.length,
    members: [...originalMembers].sort((left, right) => left - right),
    leaderNumber,
    activeNumber: activeNumber ?? null,
    order: order.map((pull) => pull.number),
    proofs: proofs
      .map((proof) => ({
        number: proof.number,
        status: proof.status,
        fingerprint: proof.fingerprint,
        representedBy: [...(proof.representedBy || [])],
        ...(proof.reason ? { reason: compact(proof.reason) } : {}),
      }))
      .sort((left, right) => left.number - right.number),
    overlapFiles: [...overlapFiles].sort(),
    escalations: [...escalations].map(compact).filter(Boolean).sort(),
    lastDispatchKey: lastDispatchKey ? compact(lastDispatchKey) : null,
    updatedAt: compact(updatedAt),
  };
  return validateCoordinatorState(state);
}

export function validateCoordinatorState(state) {
  if (state?.version !== 1) throw new Error('CI conflict state must use version 1');
  if (!Number.isInteger(state.prNumber) || state.prNumber <= 0) {
    throw new Error('CI conflict state has an invalid PR number');
  }
  if (
    !state.groupId ||
    !Number.isInteger(state.originalSize) ||
    state.originalSize < MIN_CLUSTER_SIZE
  ) {
    throw new Error('CI conflict state has invalid group metadata');
  }
  if (!Array.isArray(state.members) || state.members.length === 0) {
    throw new Error('CI conflict state has no members');
  }
  if (!Number.isInteger(state.leaderNumber) || !state.members.includes(state.leaderNumber)) {
    throw new Error('CI conflict state has an invalid leader');
  }
  if (state.activeNumber !== null && !state.members.includes(state.activeNumber)) {
    throw new Error('CI conflict state has an invalid active slot');
  }
  if (!Array.isArray(state.order) || !Array.isArray(state.proofs)) {
    throw new Error('CI conflict state has invalid order or proofs');
  }
  if (
    !Array.isArray(state.overlapFiles) ||
    !Array.isArray(state.escalations) ||
    Number.isNaN(Date.parse(state.updatedAt))
  ) {
    throw new Error('CI conflict state has invalid overlap files or timestamp');
  }
  return state;
}

export function renderCoordinatorComment(state) {
  validateCoordinatorState(state);
  const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  const proofByNumber = new Map(state.proofs.map((proof) => [proof.number, proof]));
  const orderLines =
    state.order.length === 0
      ? ['- No mergeable slot; deterministic evidence requires maintainer review.']
      : state.order.map((number, index) => {
          const proof = proofByNumber.get(number);
          const suffix = proof?.status === 'ambiguous' ? ' — **escalated; remains open**' : '';
          return `${index + 1}. #${number}${suffix}`;
        });
  const duplicateLines = state.proofs
    .filter((proof) => proof.status === 'superseded')
    .map(
      (proof) =>
        `- #${proof.number}: full-tree no-op after #${proof.representedBy.join(', #') || 'main'} (\`${proof.fingerprint.slice(0, 12)}\`)`,
    );
  return [
    COORDINATOR_MARKER,
    `${COORDINATOR_DATA_PREFIX}${encoded} -->`,
    '## CI conflict coordination',
    '',
    `- Canonical leader: #${state.leaderNumber}`,
    `- Active merge-train slot: ${state.activeNumber ? `#${state.activeNumber}` : 'none (escalated)'}`,
    `- Cluster: \`${state.groupId}\``,
    '',
    '### Explicit merge order',
    ...orderLines,
    '',
    '### Shared CI scope',
    ...(state.overlapFiles.length > 0
      ? state.overlapFiles.map((file) => `- \`${file}\``)
      : ['- No current overlap; continuing a previously observed coordination group.']),
    ...(duplicateLines.length > 0
      ? ['', '### Deterministically superseded', ...duplicateLines]
      : []),
    ...(state.escalations.length > 0
      ? ['', '### Escalations (PRs remain open)', ...state.escalations.map((item) => `- ${item}`)]
      : []),
    '',
    '_Managed by the trusted CI conflict coordinator. File overlap alone never closes a PR._',
  ].join('\n');
}

export function parseCoordinatorComment(body) {
  if (!String(body).trimStart().startsWith(COORDINATOR_MARKER)) return null;
  const escaped = COORDINATOR_DATA_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(body).match(new RegExp(`${escaped}([A-Za-z0-9_-]+)\\s*-->`));
  if (!match) throw new Error('CI conflict state marker has no encoded payload');
  try {
    return validateCoordinatorState(
      JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')),
    );
  } catch (error) {
    throw new Error(`CI conflict state payload is invalid: ${error.message}`);
  }
}

function semanticState(state) {
  const { updatedAt: _updatedAt, ...semantic } = validateCoordinatorState(state);
  return semantic;
}

export function isCoordinatorStateSemanticallyEqual(left, right) {
  if (!left || !right) return false;
  return JSON.stringify(semanticState(left)) === JSON.stringify(semanticState(right));
}
