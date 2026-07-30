import { createHash } from 'node:crypto';

import { isHealthyRecoveryOwner, isHealthyShepherdLease } from '../ci-recovery/state.mjs';
import { COORDINATOR_DATA_PREFIX, COORDINATOR_MARKER } from '../ci-recovery/markers.mjs';

export { COORDINATOR_MARKER, COORDINATOR_DATA_PREFIX };
export const COORDINATED_LABEL = 'ci-conflict-coordinated';
export const LEADER_LABEL = 'ci-conflict-leader';
export const ESCALATION_LABEL = 'ci-conflict-escalation';
export const ORDER_WAIT_LABEL = 'ci-conflict-order-wait';

/**
 * Enforcement kill switch for CI conflict coordination.
 *
 * When DISABLED (the default) the coordinator still *discovers* and reports
 * overlap groups via the coordinator comment, but it actively drains the
 * `ci-conflict-coordinated` and `ci-conflict-leader` labels and suppresses
 * grouping-derived escalation signals (`ambiguous` supersession proofs and
 * selection-binding drift). Only ownership-gated escalation signals keep
 * working, and it stops *serializing*: it no longer applies
 * `ci-conflict-order-wait`, no longer disarms auto-merge for grouping reasons,
 * and the merge train stops consulting coordinator slot ordering at promotion
 * time.
 *
 * Rationale: filename overlap is not proof of conflict. The fence is a
 * pessimistic lock with ~100:1 asymmetric cost — a false positive stalls the
 * whole group for hours (measured: 18 PRs, up to 64h), while a false negative
 * costs one rebase plus one parallel CI re-run. Branch contamination made most
 * overlaps spurious, so the lock fired mostly on non-conflicts.
 *
 * Set `CI_CONFLICT_COORDINATION_ENFORCE=1` to restore serialization. This is the
 * rollback switch — it requires no code change or redeploy.
 */
export function coordinationEnforcementEnabled(env = process.env) {
  return String(env?.CI_CONFLICT_COORDINATION_ENFORCE ?? '').trim() === '1';
}
export const MIN_CLUSTER_SIZE = 3;
// GitHub caps issue/PR comment bodies at 65 536 characters. A cluster sharing
// hundreds of CI paths would breach that limit if we render or encode the full
// list. Store and display at most this many files; the remainder is captured in
// overlapFilesCount so callers can show an accurate "…and N more" note.
export const MAX_OVERLAP_FILES = 20;
// How long a dispatch key is considered live. If the coordinator persisted a
// dispatch key but the dispatched workflow run was cancelled or failed before
// writing recovery state, the same key would suppress every future backstop
// pass forever. After this lease expires the coordinator may re-dispatch the
// active slot provided no healthy owner is found.
export const DISPATCH_LEASE_MS = 30 * 60 * 1000; // 30 minutes

const CI_WORKFLOW_PREFIX = '.github/workflows/';
const CI_SCRIPT_DIRECTORY_RE = /^\.github\/scripts\/ci-[^/]+\//;

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
  return candidate.startsWith(CI_WORKFLOW_PREFIX) || CI_SCRIPT_DIRECTORY_RE.test(candidate);
}

export function ciFilesFor(paths) {
  return [...new Set((paths || []).map(normalizedPath).filter(isCiCoordinationPath))].sort();
}

export function changeStatsFromFiles(files) {
  const inventory = Array.isArray(files) ? files : [];
  let additions = 0;
  let deletions = 0;
  for (const file of inventory) {
    additions += Number(file?.additions || 0);
    deletions += Number(file?.deletions || 0);
  }
  return { additions, deletions, changedFiles: inventory.length };
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
  _existingStates,
  minimumSize = MIN_CLUSTER_SIZE,
) {
  return clusterPullRequests(pullRequests, minimumSize);
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
    const openMembers = state.members.filter(
      (number) => (openByNumber.get(number)?.ciFiles.length ?? 0) > 0,
    );
    if (state.originalSize < MIN_CLUSTER_SIZE || openMembers.length < MIN_CLUSTER_SIZE) continue;
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

/**
 * Pure ordering predicate for conflict clusters.
 * Returns the deterministic merge order for a cluster.
 * Never writes labels or comments — the lifecycle owner is the sole writer.
 * A quarantined or abandoned PR is never returned as the leader, and never
 * appears in `order` as a predecessor (D11).
 *
 * @param {object[]} cluster - PRs in the conflict cluster
 * @param {object[]} proofs - existing proof records
 * @param {string[]} nonBlockingPhases - lifecycle phases that are non-blocking
 * @returns {{ leader: object|null, order: object[], nonBlocking: object[] }}
 */
export function whoMustLandFirst(cluster, proofs = [], nonBlockingPhases = []) {
  const nonBlockingSet = new Set(nonBlockingPhases);
  const blockingCluster = (cluster || []).filter(
    (pull) => !nonBlockingSet.has(pull.lifecyclePhase),
  );
  const nonBlockingPulls = (cluster || []).filter((pull) =>
    nonBlockingSet.has(pull.lifecyclePhase),
  );

  const ranked = rankPullRequests(blockingCluster);
  const { leader, ordered } = selectCoordination({ rankedPulls: ranked, proofs });

  return {
    leader: leader ?? null,
    order: ordered,
    nonBlocking: nonBlockingPulls,
  };
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

// Only a live shepherd lease may hold the coordinator's active slot fenced.
// Routine automation ownership must NOT, or the coordinator deadlocks against
// its own dispatch (see isHealthyShepherdLease and issue #2095).
export function hasHealthyShepherdLease({ prNumber, recoveryState, now }) {
  return isHealthyShepherdLease({ prNumber, state: recoveryState, now });
}

export function shouldDispatchActiveSlot({
  recoveryState,
  headSha,
  prNumber,
  priorDispatchKey,
  nextKey,
  // ISO timestamp of the last dispatch for this key. Used to bound how long a
  // persisted dispatch key suppresses re-dispatch: once DISPATCH_LEASE_MS has
  // elapsed and no healthy owner is found, the coordinator may retry even if
  // the key has not changed (e.g. after a lost or cancelled workflow run).
  lastDispatchAt,
  now,
}) {
  if (!nextKey) return false;
  if (hasHealthyRecoveryOwner({ prNumber, recoveryState, headSha, now })) return false;
  if (priorDispatchKey !== nextKey) return true;
  // Same key: only re-dispatch after the dispatch lease has expired so a lost
  // or cancelled run cannot trap the active slot forever.
  if (!lastDispatchAt) return false;
  return now.getTime() - new Date(lastDispatchAt).getTime() >= DISPATCH_LEASE_MS;
}

export function makeCoordinatorState({
  prNumber,
  groupId,
  originalMembers,
  leaderNumber,
  activeNumber,
  order,
  proofs,
  // Must be the complete (untruncated) overlap list from overlappingFiles(); the
  // factory stores a bounded sample and derives overlapFilesCount from the input
  // length so the "…and N more" note is always accurate.
  overlapFiles,
  escalations = [],
  lastDispatchKey = null,
  // ISO timestamp recorded when the active slot was last dispatched for this key.
  // Paired with lastDispatchKey to detect lost/cancelled runs and allow retry
  // after DISPATCH_LEASE_MS even when the key has not changed.
  lastDispatchAt = null,
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
    // Capture the total count before truncating so renderCoordinatorComment can
    // emit an accurate "…and N more" note without storing the full list.
    overlapFilesCount: overlapFiles.length,
    overlapFiles: [...overlapFiles].sort().slice(0, MAX_OVERLAP_FILES),
    escalations: [...escalations].map(compact).filter(Boolean).sort(),
    lastDispatchKey: lastDispatchKey ? compact(lastDispatchKey) : null,
    lastDispatchAt: lastDispatchAt ? compact(lastDispatchAt) : null,
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
  // overlapFilesCount is optional for backward compatibility with states serialised
  // before the field was introduced. When present it must be >= overlapFiles.length
  // (which may be a bounded sample of the full list).
  if (
    state.overlapFilesCount !== undefined &&
    (!Number.isInteger(state.overlapFilesCount) ||
      state.overlapFilesCount < state.overlapFiles.length)
  ) {
    throw new Error('CI conflict state has invalid overlapFilesCount');
  }
  // lastDispatchAt is optional (absent on states persisted before the field was
  // added) but when present must be a valid ISO timestamp.
  if (
    state.lastDispatchAt !== undefined &&
    state.lastDispatchAt !== null &&
    Number.isNaN(Date.parse(state.lastDispatchAt))
  ) {
    throw new Error('CI conflict state has invalid lastDispatchAt');
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
  // overlapFiles is already bounded to MAX_OVERLAP_FILES; overlapFilesCount holds
  // the original total so we can render an accurate "…and N more" note.
  const hiddenCount =
    (state.overlapFilesCount ?? state.overlapFiles.length) - state.overlapFiles.length;
  const overlapLines =
    state.overlapFiles.length > 0
      ? [
          ...state.overlapFiles.map((file) => `- \`${file}\``),
          ...(hiddenCount > 0 ? [`- _…and ${hiddenCount} more_`] : []),
        ]
      : ['- No current overlap; continuing a previously observed coordination group.'];
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
    ...overlapLines,
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
