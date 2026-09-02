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

export function lifecycleWriterEnabled({ owner, legacyBridgeEnabled }, actor) {
  const selected = lifecycleMutationOwner(owner);
  if (legacyBridgeEnabled !== 'true' && legacyBridgeEnabled !== 'false') return false;
  if (selected === 'goobers') return actor === 'goobers' && legacyBridgeEnabled === 'false';
  if (selected === 'legacy') return actor === 'legacy' && legacyBridgeEnabled === 'true';
  return false;
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

export function lifecycleLeaseKey({ repository, prNumber, headSha }) {
  return `${String(repository).toLowerCase()}#${Number(prNumber)}@${String(headSha).toLowerCase()}`;
}

export function renderLifecycleLease(lease) {
  const encoded = Buffer.from(JSON.stringify(lease), 'utf8').toString('base64url');
  return [
    LIFECYCLE_LEASE_MARKER,
    `${LIFECYCLE_LEASE_DATA_PREFIX}${encoded} -->`,
    '## Lifecycle ownership lease',
    '',
    `- Owner: \`${lease.owner}\``,
    `- PR/head: \`#${lease.prNumber}@${lease.headSha}\``,
    `- Lease: \`${lease.leaseId}\``,
    `- Expires: \`${lease.expiresAt}\``,
  ].join('\n');
}

export function parseLifecycleLease(body) {
  if (
    !String(body ?? '')
      .trimStart()
      .startsWith(LIFECYCLE_LEASE_MARKER)
  )
    return null;
  const encoded = String(body).match(
    new RegExp(`${LIFECYCLE_LEASE_DATA_PREFIX}([A-Za-z0-9_-]+) -->`),
  )?.[1];
  if (!encoded) return null;
  try {
    const lease = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      lease?.version !== 1 ||
      lease?.owner !== 'goobers' ||
      !Number.isInteger(lease?.prNumber) ||
      !/^[0-9a-f]{40}$/i.test(lease?.headSha) ||
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

function result(status, reason, input, lease = null, writeAction = 'none') {
  return {
    status,
    reason,
    lockKey: lifecycleLeaseKey(input),
    lease,
    writeAction,
    observable: true,
  };
}

export function decideLifecycleLease(input) {
  const repository = String(input.repository ?? '').trim();
  const headRepository = String(input.headRepository ?? '').trim();
  const headSha = String(input.headSha ?? '')
    .trim()
    .toLowerCase();
  const liveHeadSha = String(input.liveHeadSha ?? '')
    .trim()
    .toLowerCase();
  const prNumber = Number(input.prNumber);
  const leaseId = String(input.leaseId ?? '').trim();
  const operation = String(input.operation ?? '').trim();
  const now = String(input.now ?? '').trim();
  const scope = { repository, prNumber, headSha };

  if (!lifecycleWriterEnabled(input, 'goobers')) {
    return result('observe-only', 'goobers-not-selected', scope);
  }
  if (!repository || repository.toLowerCase() !== headRepository.toLowerCase()) {
    return result('rejected', 'fork', scope);
  }
  if (
    !Number.isInteger(prNumber) ||
    prNumber < 1 ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    !/^[0-9a-f]{40}$/.test(liveHeadSha) ||
    !leaseId ||
    !['acquire', 'heartbeat', 'release'].includes(operation) ||
    !Number.isFinite(Date.parse(now))
  ) {
    return result('rejected', 'invalid-input', scope);
  }
  if (liveHeadSha !== headSha) {
    return result('rejected', 'stale-head', scope);
  }

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

  if (operation === 'release') {
    if (!currentLease) return result('released', 'already-released', scope);
    if (!sameScope || currentLease.leaseId !== leaseId) {
      return result('contended', 'lease-not-held', scope, currentLease);
    }
    return {
      ...result('released', 'lease-released', scope, null, 'delete'),
      expectedCommentId: current.id,
      expectedLeaseId: currentLease.leaseId,
    };
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
    prNumber,
    headSha,
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
  return {
    ...result(status, reason, scope, lease, current ? 'update' : 'create'),
    expectedCommentId: current?.id ?? null,
    expectedLeaseId: currentLease?.leaseId ?? null,
  };
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
