import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LIFECYCLE_LEASE_DATA_PREFIX, LIFECYCLE_LEASE_MARKER } from './ci-recovery/markers.mjs';
import { TRUSTED_ASSOCIATIONS, TRUSTED_BOT_LOGINS } from './ci-recovery/state.mjs';

export { LIFECYCLE_LEASE_DATA_PREFIX, LIFECYCLE_LEASE_MARKER };
export const DEFAULT_LIFECYCLE_LEASE_TTL_SECONDS = 300;

export function lifecycleLeaseTtlSeconds(value = process.env.LIFECYCLE_LEASE_TTL_SECONDS) {
  const raw = String(value ?? '');
  if (!/^\d+$/.test(raw)) return DEFAULT_LIFECYCLE_LEASE_TTL_SECONDS;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds >= 120 && seconds <= 3600
    ? seconds
    : DEFAULT_LIFECYCLE_LEASE_TTL_SECONDS;
}

export function lifecycleMutationOwner(value) {
  return value === 'goobers' || value === 'legacy' ? value : 'off';
}

/**
 * Mutation lanes. Ownership is resolved per lane so a migration can move one
 * lane at a time. `implementation-claim` is the only lane Phase 2 hands to
 * Goobers; every other lane is a PR-lifecycle lane that legacy automation still
 * owns until its own Phase 3 migration.
 */
export const LIFECYCLE_CLAIM_LANE = 'implementation-claim';
export const LIFECYCLE_PR_LANES = Object.freeze([
  'ci-recovery',
  'review-threads',
  'branch-update',
  'merge-train',
]);
export const LIFECYCLE_LANES = Object.freeze([LIFECYCLE_CLAIM_LANE, ...LIFECYCLE_PR_LANES]);

/**
 * Resolve the single writer for one lane.
 *
 * The two lane families fail in deliberately opposite directions:
 *
 * - `implementation-claim` fails **closed** (`off`). Two writers racing the
 *   same claim would duplicate implementation work, so anything other than the
 *   literal `goobers`/`legacy` selector disables the lane entirely.
 * - Every PR-lifecycle lane fails **operational** (`legacy`). These lanes are
 *   required for PRs to keep moving, so an unset, misspelled, or malformed
 *   selector must never silently take the lane offline. Only the literal
 *   `goobers` migrates a lane; everything else leaves legacy in charge.
 *
 * This asymmetry is the whole point: selecting Goobers for the claim lane can
 * never disable an unmigrated PR-lifecycle lane, so the cutover has no gap.
 */
export function lifecycleLaneOwner(lane, config = {}) {
  if (lane === LIFECYCLE_CLAIM_LANE) return lifecycleMutationOwner(config.owner);
  if (!LIFECYCLE_PR_LANES.includes(lane)) return 'off';
  return config.laneOwners?.[lane] === 'goobers' ? 'goobers' : 'legacy';
}

/**
 * `LEGACY_CI_MUTATION_BRIDGE_ENABLED` remains the global emergency kill switch
 * for every legacy mutation: it must be the literal `true` for legacy to write
 * anything. It does NOT gate Goobers, so the claim lane and the legacy lanes
 * are independently controlled.
 */
export function lifecycleLaneWriterEnabled(lane, config, actor) {
  const owner = lifecycleLaneOwner(lane, config);
  if (owner === 'off' || owner !== actor) return false;
  if (actor === 'legacy') return config?.legacyBridgeEnabled === 'true';
  return actor === 'goobers';
}

/** Claim-lane writer check retained for the ownership workflow's trust fences. */
export function lifecycleWriterEnabled(config, actor) {
  return lifecycleLaneWriterEnabled(LIFECYCLE_CLAIM_LANE, config, actor);
}

/**
 * Trust boundary for lease marker comments: only GitHub Apps/bots the recovery
 * automation already trusts, org owners, members, and collaborators may write
 * an authoritative lease comment. Anyone can comment on a public PR, so an
 * unfiltered marker scan would let an external commenter forge or permanently
 * poison the lease state.
 */
export function isTrustedLifecycleLeaseComment(comment) {
  if (!comment) return false;
  const login = String(comment.user?.login ?? comment.author?.login ?? '').toLowerCase();
  const association = String(comment.author_association ?? '').toUpperCase();
  return TRUSTED_ASSOCIATIONS.has(association) || TRUSTED_BOT_LOGINS.has(login);
}

/** Trusted lease marker comments, in API order. */
export function selectLifecycleLeaseComments(comments) {
  return (Array.isArray(comments) ? comments : []).filter(
    (comment) =>
      String(comment?.body || '')
        .trimStart()
        .startsWith(LIFECYCLE_LEASE_MARKER) && isTrustedLifecycleLeaseComment(comment),
  );
}

export function lifecycleLeaseKey({ repository, issueNumber }) {
  return `${String(repository).toLowerCase()}#issue-${Number(issueNumber)}`;
}

export function renderLifecycleLease(lease) {
  const encoded = Buffer.from(JSON.stringify(lease), 'utf8').toString('base64url');
  return [
    LIFECYCLE_LEASE_MARKER,
    `${LIFECYCLE_LEASE_DATA_PREFIX}${encoded} -->`,
    '## Implementation claim lease',
    '',
    `- Owner: \`${lease.owner}\``,
    `- Issue: \`#${lease.issueNumber}\``,
    `- Lease: \`${lease.leaseId}\``,
    `- Expires: \`${lease.expiresAt}\``,
    '',
    '_Scoped to pre-PR implementation. Released at PR publication, after which',
    'legacy automation owns the PR lifecycle._',
  ].join('\n');
}

/** Registry-defined data prefix, escaped so it is matched literally. */
const LEASE_DATA_PATTERN = new RegExp(
  `${LIFECYCLE_LEASE_DATA_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([A-Za-z0-9_-]+) -->`,
);

export function parseLifecycleLease(body) {
  if (
    !String(body ?? '')
      .trimStart()
      .startsWith(LIFECYCLE_LEASE_MARKER)
  )
    return null;
  const encoded = String(body).match(LEASE_DATA_PATTERN)?.[1];
  if (!encoded) return null;
  try {
    const lease = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      lease?.version !== 1 ||
      lease?.owner !== 'goobers' ||
      !Number.isInteger(lease?.issueNumber) ||
      lease.issueNumber < 1 ||
      typeof lease?.repository !== 'string' ||
      typeof lease?.leaseId !== 'string' ||
      !Number.isFinite(Date.parse(lease?.acquiredAt)) ||
      !Number.isFinite(Date.parse(lease?.expiresAt))
    ) {
      return null;
    }
    return lease;
  } catch {
    return null;
  }
}

function result(status, reason, input, lease = null, writeAction = 'none', extra = {}) {
  return {
    status,
    reason,
    lockKey: lifecycleLeaseKey(input),
    lease,
    writeAction,
    observable: true,
    ...extra,
  };
}

const LEASE_OPERATIONS = ['acquire', 'heartbeat', 'handoff', 'release'];

/**
 * Structural check that `value` is the canonical GitHub URL of a pull request
 * in `repository`.
 *
 * A `startsWith` prefix test is not sufficient: `.../pull/1/../../../other`
 * shares the prefix but addresses a different resource, and a host like
 * `github.com.evil.test` would pass a naive string compare. Parsing the URL and
 * matching host plus exact path segments removes that whole class.
 */
export function isRepositoryPullRequestUrl(value, repository) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.host.toLowerCase() !== 'github.com') return false;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 4) return false;
  const [owner, repo, kind, number] = segments;
  return (
    `${owner}/${repo}`.toLowerCase() === repository.toLowerCase() &&
    kind === 'pull' &&
    /^[1-9]\d*$/.test(number)
  );
}

/**
 * Decide the next state of the pre-PR implementation claim lease.
 *
 * The lease exists only to stop two implementers claiming the same approved
 * issue. It is deliberately NOT a PR-lifecycle lease: `handoff` releases it at
 * PR publication, and no PR-lifecycle lane consults it, so legacy automation
 * takes over the published PR with no gap and no dual writer.
 */
export function decideLifecycleLease(input) {
  const repository = String(input.repository ?? '').trim();
  const headRepository = String(input.headRepository ?? '').trim();
  const issueNumber = Number(input.issueNumber);
  const leaseId = String(input.leaseId ?? '').trim();
  const operation = String(input.operation ?? '').trim();
  const now = String(input.now ?? '').trim();
  const prUrl = String(input.prUrl ?? '').trim();
  const scope = { repository, issueNumber };

  if (!lifecycleWriterEnabled(input, 'goobers')) {
    return result('observe-only', 'goobers-not-selected', scope);
  }
  // `pull_request_target` grants base-repository write permission even for fork
  // PRs. Without this fence an outside contributor could open a fork PR whose
  // body says "Fixes #N" and make the publication handoff delete a legitimate
  // implementation claim on that issue.
  if (!repository || repository.toLowerCase() !== headRepository.toLowerCase()) {
    return result('rejected', 'fork', scope);
  }
  if (
    !Number.isInteger(issueNumber) ||
    issueNumber < 1 ||
    !leaseId ||
    !LEASE_OPERATIONS.includes(operation) ||
    !Number.isFinite(Date.parse(now))
  ) {
    return result('rejected', 'invalid-input', scope);
  }
  // A handoff is the audit record of "Goobers finished; legacy owns the PR
  // now", so it is only meaningful for a PR in this same repository. The URL is
  // matched structurally rather than by prefix so a crafted path cannot smuggle
  // a different target past the check.
  if (operation === 'handoff' && !isRepositoryPullRequestUrl(prUrl, repository)) {
    return result('rejected', 'invalid-handoff-target', scope);
  }
  // A handoff is the audit record of "Goobers finished; legacy owns the PR
  // now", so it is only meaningful with a PR in this same repository.

  const markerComments = Array.isArray(input.markerComments) ? input.markerComments : [];
  const parsed = markerComments.map((comment) => ({
    id: Number(comment.id),
    lease: parseLifecycleLease(comment.body),
  }));
  if (parsed.some((entry) => !Number.isInteger(entry.id) || !entry.lease)) {
    return result('contended', 'invalid-lease-state', scope);
  }
  if (parsed.length > 1) {
    return result('contended', 'duplicate-lease-state', scope);
  }

  const current = parsed[0] ?? null;
  const currentLease = current?.lease ?? null;
  const sameScope = currentLease && lifecycleLeaseKey(currentLease) === lifecycleLeaseKey(scope);
  const active = currentLease && Date.parse(currentLease.expiresAt) > Date.parse(now);

  if (operation === 'release' || operation === 'handoff') {
    const handedOff = operation === 'handoff';
    const extra = handedOff ? { prUrl } : {};
    if (!currentLease) {
      // Idempotent: a replayed publication event must still report the
      // terminal state rather than failing the handoff.
      return result(
        handedOff ? 'handed-off' : 'released',
        'already-released',
        scope,
        null,
        'none',
        extra,
      );
    }
    if (!sameScope || currentLease.leaseId !== leaseId) {
      return result('contended', 'lease-not-held', scope, currentLease, 'none', extra);
    }
    return result(
      handedOff ? 'handed-off' : 'released',
      handedOff ? 'handoff-complete' : 'lease-released',
      scope,
      null,
      'delete',
      {
        ...extra,
        expectedCommentId: current.id,
        expectedLeaseId: currentLease.leaseId,
      },
    );
  }

  if (operation === 'heartbeat') {
    if (!sameScope || !active || currentLease.leaseId !== leaseId) {
      return result('contended', 'lease-not-held', scope, currentLease);
    }
  } else if (sameScope && active && currentLease.leaseId !== leaseId) {
    return result('contended', 'active-lease', scope, currentLease);
  }

  const acquiredAt =
    sameScope && active && currentLease?.leaseId === leaseId ? currentLease.acquiredAt : now;
  const lease = {
    version: 1,
    owner: 'goobers',
    repository,
    issueNumber,
    leaseId,
    acquiredAt,
    expiresAt: new Date(
      Date.parse(now) + lifecycleLeaseTtlSeconds(input.ttlSeconds) * 1000,
    ).toISOString(),
  };
  const status =
    operation === 'heartbeat' || (sameScope && currentLease?.leaseId === leaseId)
      ? 'renewed'
      : 'acquired';
  const reason = !currentLease
    ? 'lease-created'
    : sameScope && active
      ? 'lease-renewed'
      : 'lease-takeover';
  return result(status, reason, scope, lease, current ? 'update' : 'create', {
    expectedCommentId: current?.id ?? null,
    expectedLeaseId: currentLease?.leaseId ?? null,
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    options[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.input !== 'string') throw new Error('--input is required');
  const input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const decision = decideLifecycleLease(input);
  const outputPath = String(args.output || 'lifecycle-ownership-result.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({ decision: JSON.stringify(decision) }, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ status: decision.status, reason: decision.reason, lockKey: decision.lockKey })}\n`,
  );
}
