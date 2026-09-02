import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  decideLifecycleLease,
  isTrustedLifecycleLeaseComment,
  LIFECYCLE_LEASE_MARKER,
  lifecycleLeaseTtlSeconds,
  lifecycleWriterEnabled,
  parseLifecycleLease,
  renderLifecycleLease,
  selectLifecycleLeaseComments,
} = await import(path.join(repositoryRoot, '.github/scripts/lifecycle-ownership.mjs'));
const markers = await import(path.join(repositoryRoot, '.github/scripts/ci-recovery/markers.mjs'));

const headSha = 'a'.repeat(40);
const base = {
  owner: 'goobers',
  legacyBridgeEnabled: 'false',
  repository: 'nalfeo/Crawler',
  headRepository: 'nalfeo/Crawler',
  prNumber: 42,
  headSha,
  liveHeadSha: headSha,
  leaseId: 'goobers:100:1',
  operation: 'acquire',
  now: '2026-09-02T03:00:00.000Z',
  ttlSeconds: '300',
  markerComments: [],
};

function markerComment(
  leaseId: string,
  expiresAt = '2026-09-02T03:05:00.000Z',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 7,
    body: renderLifecycleLease({
      version: 1,
      owner: 'goobers',
      repository: base.repository,
      prNumber: base.prNumber,
      headSha,
      leaseId,
      acquiredAt: base.now,
      expiresAt,
      ...overrides,
    }),
  };
}

describe('Goobers lifecycle ownership', () => {
  it('bounds the operational lease TTL and defaults invalid values', () => {
    expect(lifecycleLeaseTtlSeconds('120')).toBe(120);
    expect(lifecycleLeaseTtlSeconds('3600')).toBe(3600);
    expect(lifecycleLeaseTtlSeconds('119')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('3601')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('invalid')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('120junk')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('120.9')).toBe(300);
    expect(lifecycleLeaseTtlSeconds(' 600 ')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('-300')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('')).toBe(300);
    expect(lifecycleLeaseTtlSeconds(undefined)).toBe(300);
  });

  it('sources the managed lease marker from the marker registry', () => {
    expect(LIFECYCLE_LEASE_MARKER).toBe(markers.LIFECYCLE_LEASE_MARKER);
    expect(markers.MANAGED_COMMENT_MARKERS).toContain(markers.LIFECYCLE_LEASE_MARKER);
    expect(markers.MANAGED_COMMENT_MARKERS).toContain(markers.LIFECYCLE_LEASE_DATA_PREFIX);
    expect(renderLifecycleLease({ ...base, owner: 'goobers', version: 1 })).toContain(
      markers.LIFECYCLE_LEASE_DATA_PREFIX,
    );
  });

  it('keeps the Goobers task decision-only', () => {
    const workflow = parse(
      fs.readFileSync(
        path.join(
          repositoryRoot,
          '.goobers/gaggles/crawler/workflows/crawler-lifecycle-owner.yaml',
        ),
        'utf8',
      ),
    );
    const task = workflow.spec.tasks.find(
      (candidate: { name: string }) => candidate.name === 'decide-ownership',
    );

    expect(task.capabilities).toBeUndefined();
    expect(task.expectedOutputs).toEqual(['decision']);
    expect(task.run.script).toContain('.github/scripts/lifecycle-ownership.mjs');
  });

  it('selects exactly one writer and fails closed on invalid knob combinations', () => {
    expect(
      lifecycleWriterEnabled({ owner: 'goobers', legacyBridgeEnabled: 'false' }, 'goobers'),
    ).toBe(true);
    expect(
      lifecycleWriterEnabled({ owner: 'goobers', legacyBridgeEnabled: 'false' }, 'legacy'),
    ).toBe(false);
    expect(lifecycleWriterEnabled({ owner: 'legacy', legacyBridgeEnabled: 'true' }, 'legacy')).toBe(
      true,
    );
    expect(
      lifecycleWriterEnabled({ owner: 'legacy', legacyBridgeEnabled: 'true' }, 'goobers'),
    ).toBe(false);

    for (const config of [
      { owner: '', legacyBridgeEnabled: 'false' },
      { owner: 'typo', legacyBridgeEnabled: 'true' },
      { owner: 'goobers', legacyBridgeEnabled: 'true' },
      { owner: 'legacy', legacyBridgeEnabled: 'false' },
      { owner: 'Goobers', legacyBridgeEnabled: 'false' },
      { owner: ' goobers', legacyBridgeEnabled: 'false' },
      { owner: 'goobers', legacyBridgeEnabled: 'tru' },
      { owner: 'goobers', legacyBridgeEnabled: 'FALSE' },
      { owner: 'goobers', legacyBridgeEnabled: ' false ' },
      { owner: 'goobers', legacyBridgeEnabled: '' },
      { owner: 'goobers', legacyBridgeEnabled: undefined },
      { owner: 'LEGACY', legacyBridgeEnabled: 'true' },
      { owner: 'legacy', legacyBridgeEnabled: 'True' },
      { owner: undefined, legacyBridgeEnabled: 'false' },
    ]) {
      expect(lifecycleWriterEnabled(config, 'goobers')).toBe(false);
      expect(lifecycleWriterEnabled(config, 'legacy')).toBe(false);
    }
  });

  it('acquires, renders, parses, and renews the same lease idempotently', () => {
    const acquired = decideLifecycleLease(base);
    expect(acquired).toMatchObject({
      status: 'acquired',
      reason: 'lease-created',
      writeAction: 'create',
      lockKey: `nalfeo/crawler#42@${headSha}`,
    });

    const rendered = renderLifecycleLease(acquired.lease);
    expect(parseLifecycleLease(rendered)).toEqual(acquired.lease);

    const renewed = decideLifecycleLease({
      ...base,
      operation: 'heartbeat',
      now: '2026-09-02T03:01:00.000Z',
      markerComments: [{ id: 7, body: rendered }],
    });
    expect(renewed).toMatchObject({
      status: 'renewed',
      reason: 'lease-renewed',
      writeAction: 'update',
      expectedCommentId: 7,
      expectedLeaseId: base.leaseId,
    });
  });

  it('retains the active incumbent and deterministically permits expired takeover', () => {
    const contended = decideLifecycleLease({
      ...base,
      leaseId: 'goobers:200:1',
      markerComments: [markerComment(base.leaseId)],
    });
    expect(contended).toMatchObject({
      status: 'contended',
      reason: 'active-lease',
      writeAction: 'none',
      lease: { leaseId: base.leaseId },
    });

    const takeover = decideLifecycleLease({
      ...base,
      leaseId: 'goobers:200:1',
      now: '2026-09-02T03:06:00.000Z',
      markerComments: [markerComment(base.leaseId)],
    });
    expect(takeover).toMatchObject({
      status: 'acquired',
      reason: 'lease-takeover',
      writeAction: 'update',
      expectedCommentId: 7,
      expectedLeaseId: base.leaseId,
      lease: {
        leaseId: 'goobers:200:1',
        acquiredAt: '2026-09-02T03:06:00.000Z',
      },
    });
  });

  it('rejects forks with the same result shape as same-repo input validation', () => {
    expect(decideLifecycleLease({ ...base, headRepository: 'attacker/Crawler' })).toMatchObject({
      status: 'rejected',
      reason: 'fork',
      writeAction: 'none',
      observable: true,
    });
    expect(decideLifecycleLease({ ...base, headSha: 'short', liveHeadSha: 'short' })).toMatchObject(
      {
        status: 'rejected',
        reason: 'invalid-input',
        writeAction: 'none',
        observable: true,
      },
    );
  });

  it('rejects a stale caller head against the live PR head before deciding a lease', () => {
    expect(decideLifecycleLease({ ...base, liveHeadSha: 'b'.repeat(40) })).toMatchObject({
      status: 'rejected',
      reason: 'stale-head',
      writeAction: 'none',
      lease: null,
      observable: true,
    });
    expect(decideLifecycleLease({ ...base, liveHeadSha: '' })).toMatchObject({
      status: 'rejected',
      reason: 'invalid-input',
      writeAction: 'none',
    });
  });

  it('counts only trusted authors when reading lease marker comments', () => {
    const trusted = { ...markerComment(base.leaseId), user: { login: 'github-actions[bot]' } };
    const forged = {
      id: 9,
      body: markerComment('forged').body,
      user: { login: 'drive-by' },
      author_association: 'NONE',
    };
    const poisoned = {
      id: 10,
      body: `${LIFECYCLE_LEASE_MARKER} malformed`,
      user: { login: 'drive-by' },
      author_association: 'CONTRIBUTOR',
    };

    expect(isTrustedLifecycleLeaseComment(trusted)).toBe(true);
    expect(isTrustedLifecycleLeaseComment(forged)).toBe(false);
    expect(isTrustedLifecycleLeaseComment({ ...forged, author_association: 'COLLABORATOR' })).toBe(
      true,
    );
    expect(selectLifecycleLeaseComments([trusted, forged, poisoned])).toEqual([trusted]);
    expect(selectLifecycleLeaseComments([forged, poisoned])).toEqual([]);
    expect(
      decideLifecycleLease({
        ...base,
        markerComments: selectLifecycleLeaseComments([forged, poisoned]).map(
          (comment: { id: number; body: string }) => ({
            id: comment.id,
            body: comment.body,
          }),
        ),
      }),
    ).toMatchObject({ status: 'acquired', reason: 'lease-created' });
  });

  it('fails closed on malformed or duplicate marker state', () => {
    expect(
      decideLifecycleLease({
        ...base,
        markerComments: [{ id: 7, body: '<!-- crawler-lifecycle-lease:v1 --> malformed' }],
      }),
    ).toMatchObject({ status: 'contended', reason: 'invalid-lease-state' });
    expect(
      decideLifecycleLease({
        ...base,
        markerComments: [markerComment('first'), { ...markerComment('second'), id: 8 }],
      }),
    ).toMatchObject({ status: 'contended', reason: 'duplicate-lease-state' });
  });

  it('makes the kill switch immediately observe-only and requires the exact holder to release', () => {
    const current = markerComment(base.leaseId);
    expect(
      decideLifecycleLease({
        ...base,
        owner: 'legacy',
        legacyBridgeEnabled: 'true',
        markerComments: [current],
      }),
    ).toMatchObject({ status: 'observe-only', reason: 'goobers-not-selected' });
    expect(
      decideLifecycleLease({
        ...base,
        operation: 'release',
        leaseId: 'different-run',
        markerComments: [current],
      }),
    ).toMatchObject({ status: 'contended', reason: 'lease-not-held' });
    expect(
      decideLifecycleLease({ ...base, operation: 'release', markerComments: [current] }),
    ).toMatchObject({
      status: 'released',
      reason: 'lease-released',
      writeAction: 'delete',
      expectedCommentId: 7,
    });
  });
});
