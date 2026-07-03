import { describe, expect, it, vi } from 'vitest';
import type { OpenAssetRequestIssue } from '../../../scripts/sprites/sidecar/asset-request-issue-api.js';
import type {
  EnqueueCommentContext,
  IssueIngesterStatus,
} from '../../../scripts/sprites/sidecar/issue-ingester-controller.js';
import {
  exitCodeForStatus,
  filterIssuesByAllowedAuthors,
  formatEnqueueCommentBody,
  resolveAllowedAuthorLogins,
  resolveRequestedBy,
  resolveRunUrl,
  resolveStaleClaimTtlMs,
  resolveTargetIssueNumber,
  withAuthorAllowList,
} from '../../../scripts/sprites/ingest-once-cli-lib.js';

function status(overrides: Partial<IssueIngesterStatus> = {}): IssueIngesterStatus {
  return {
    running: false,
    startedAt: null,
    stoppedAt: null,
    lastPollAt: null,
    lastError: null,
    enqueued: 0,
    skippedDuplicate: 0,
    reclaimedStale: 0,
    enqueueCommentsPosted: 0,
    enqueueCommentErrors: 0,
    lastEnqueueCommentError: null,
    ...overrides,
  };
}

function enqueueCtx(overrides: Partial<EnqueueCommentContext> = {}): EnqueueCommentContext {
  return {
    issueNumber: 42,
    name: 'bone-dagger',
    briefSentence: 'A chipped bone dagger.',
    fingerprint: 'deadbeefcafefeedcafe',
    claimedAt: '2026-07-03T00:00:00.000Z',
    reclaimed: false,
    ...overrides,
  };
}

describe('resolveRequestedBy', () => {
  it('prefers GITHUB_ACTOR (CI path)', () => {
    expect(resolveRequestedBy({ GITHUB_ACTOR: 'ci-bot', USER: 'nalfeo' })).toBe('ci-bot');
  });

  it('falls back to USER when GITHUB_ACTOR is missing', () => {
    expect(resolveRequestedBy({ USER: 'nalfeo' })).toBe('nalfeo');
  });

  it('falls back to USERNAME on Windows-style env', () => {
    expect(resolveRequestedBy({ USERNAME: 'nalfeo' })).toBe('nalfeo');
  });

  it('uses a stable default when no identity is available', () => {
    expect(resolveRequestedBy({})).toBe('ci-ingest');
  });
});

describe('exitCodeForStatus', () => {
  it('returns 0 for a clean poll with no items enqueued', () => {
    expect(exitCodeForStatus(status())).toBe(0);
  });

  it('returns 0 for a clean poll that enqueued items', () => {
    expect(exitCodeForStatus(status({ enqueued: 3, lastPollAt: '2026-07-03T00:00:00.000Z' }))).toBe(
      0,
    );
  });

  it('returns 1 when lastError is populated (the poll surfaced a real failure)', () => {
    expect(exitCodeForStatus(status({ lastError: 'gh CLI failed' }))).toBe(1);
  });

  it('returns 0 when only enqueue-comment posts failed (best-effort, must not skip the drain)', () => {
    expect(
      exitCodeForStatus(
        status({
          enqueued: 2,
          enqueueCommentErrors: 1,
          lastEnqueueCommentError: 'enqueue-comment failed for issue #7: gh 403',
        }),
      ),
    ).toBe(0);
  });
});

describe('resolveAllowedAuthorLogins', () => {
  it('returns null when the env var is unset (allow all)', () => {
    expect(resolveAllowedAuthorLogins({})).toBeNull();
  });

  it('returns null when the env var is an empty string (allow all)', () => {
    expect(resolveAllowedAuthorLogins({ SPRITES_INGESTER_ALLOWED_AUTHORS: '' })).toBeNull();
  });

  it('returns null when the env var contains only whitespace/commas', () => {
    expect(resolveAllowedAuthorLogins({ SPRITES_INGESTER_ALLOWED_AUTHORS: ' , , ' })).toBeNull();
  });

  it('parses a single login and lowercases it', () => {
    const set = resolveAllowedAuthorLogins({ SPRITES_INGESTER_ALLOWED_AUTHORS: 'Nalfeo' });
    expect(set).not.toBeNull();
    expect([...(set ?? [])]).toEqual(['nalfeo']);
  });

  it('parses multiple logins, trims whitespace, lowercases, and de-duplicates', () => {
    const set = resolveAllowedAuthorLogins({
      SPRITES_INGESTER_ALLOWED_AUTHORS: 'nalfeo, Copilot , NALFEO,github-actions[bot]',
    });
    expect(set).not.toBeNull();
    expect(new Set([...(set ?? [])])).toEqual(
      new Set(['nalfeo', 'copilot', 'github-actions[bot]']),
    );
  });
});

describe('filterIssuesByAllowedAuthors', () => {
  const issue = (n: number, login: string | undefined): OpenAssetRequestIssue => ({
    number: n,
    body: `### Name\nx${n}\n\n### Brief\nA brief.`,
    ...(login === undefined ? {} : { authorLogin: login }),
  });

  it('keeps issues whose author is in the allow set (case-insensitive)', () => {
    const kept = filterIssuesByAllowedAuthors(
      [issue(1, 'nalfeo'), issue(2, 'NALFEO'), issue(3, 'other')],
      new Set(['nalfeo']),
    );
    expect(kept.map((i) => i.number)).toEqual([1, 2]);
  });

  it('rejects issues with an undefined authorLogin (fail-closed)', () => {
    const kept = filterIssuesByAllowedAuthors(
      [issue(1, undefined), issue(2, 'nalfeo')],
      new Set(['nalfeo']),
    );
    expect(kept.map((i) => i.number)).toEqual([2]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterIssuesByAllowedAuthors([issue(1, 'random')], new Set(['nalfeo']))).toEqual([]);
  });
});

describe('withAuthorAllowList', () => {
  it('wraps listOpenAssetRequestIssues to apply the allow list', async () => {
    const inner = {
      listOpenAssetRequestIssues: vi.fn(async () => [
        { number: 1, body: 'a', authorLogin: 'nalfeo' },
        { number: 2, body: 'b', authorLogin: 'drive-by' },
      ]),
      getIssue: vi.fn(async () => null),
      comment: vi.fn(async () => {}),
    };
    const wrapped = withAuthorAllowList(inner, new Set(['nalfeo']));

    const listed = await wrapped.listOpenAssetRequestIssues();
    expect(listed.map((i) => i.number)).toEqual([1]);
    expect(inner.listOpenAssetRequestIssues).toHaveBeenCalledTimes(1);
  });

  it('passes comment through untouched', async () => {
    const inner = {
      listOpenAssetRequestIssues: vi.fn(async () => []),
      getIssue: vi.fn(async () => null),
      comment: vi.fn(async () => {}),
    };
    const wrapped = withAuthorAllowList(inner, new Set(['nalfeo']));

    await wrapped.comment(42, 'hello');
    expect(inner.comment).toHaveBeenCalledWith(42, 'hello');
  });

  it('applies the allow list to getIssue as well (fail-closed)', async () => {
    const inner = {
      listOpenAssetRequestIssues: vi.fn(async () => []),
      getIssue: vi.fn(
        async (n: number): Promise<OpenAssetRequestIssue | null> =>
          n === 100
            ? { number: 100, body: 'x', authorLogin: 'nalfeo' }
            : n === 200
              ? { number: 200, body: 'y', authorLogin: 'drive-by' }
              : n === 300
                ? { number: 300, body: 'z' } // no author → reject
                : null,
      ),
      comment: vi.fn(async () => {}),
    };
    const wrapped = withAuthorAllowList(inner, new Set(['nalfeo']));

    // Allowed → passes through with full body.
    const trusted = await wrapped.getIssue(100);
    expect(trusted).toEqual({ number: 100, body: 'x', authorLogin: 'nalfeo' });

    // Untrusted author → filtered out.
    expect(await wrapped.getIssue(200)).toBeNull();

    // Missing author → filtered out (fail-closed) — mirrors listOpen behavior.
    expect(await wrapped.getIssue(300)).toBeNull();
  });
});

describe('resolveTargetIssueNumber', () => {
  it('returns null when the env var is unset', () => {
    expect(resolveTargetIssueNumber({})).toBeNull();
  });

  it('returns null when the env var is an empty string', () => {
    expect(resolveTargetIssueNumber({ SPRITES_INGESTER_TARGET_ISSUE: '' })).toBeNull();
  });

  it('returns null when the env var is whitespace only', () => {
    expect(resolveTargetIssueNumber({ SPRITES_INGESTER_TARGET_ISSUE: '   ' })).toBeNull();
  });

  it('returns null for non-integer values (silent degrade to sweep-only)', () => {
    expect(resolveTargetIssueNumber({ SPRITES_INGESTER_TARGET_ISSUE: 'abc' })).toBeNull();
    expect(resolveTargetIssueNumber({ SPRITES_INGESTER_TARGET_ISSUE: '3.14' })).toBeNull();
  });

  it('returns null for zero or negative issue numbers', () => {
    expect(resolveTargetIssueNumber({ SPRITES_INGESTER_TARGET_ISSUE: '0' })).toBeNull();
    expect(resolveTargetIssueNumber({ SPRITES_INGESTER_TARGET_ISSUE: '-5' })).toBeNull();
  });

  it('parses a valid positive integer', () => {
    expect(resolveTargetIssueNumber({ SPRITES_INGESTER_TARGET_ISSUE: '724' })).toBe(724);
  });

  it('accepts surrounding whitespace', () => {
    expect(resolveTargetIssueNumber({ SPRITES_INGESTER_TARGET_ISSUE: '  724  ' })).toBe(724);
  });
});

describe('resolveStaleClaimTtlMs', () => {
  it('returns null when unset (disables reclaim, preserves strict dedup)', () => {
    expect(resolveStaleClaimTtlMs({})).toBeNull();
  });

  it('returns null for non-positive values', () => {
    expect(resolveStaleClaimTtlMs({ SPRITES_INGESTER_STALE_CLAIM_TTL_MS: '0' })).toBeNull();
    expect(resolveStaleClaimTtlMs({ SPRITES_INGESTER_STALE_CLAIM_TTL_MS: '-1000' })).toBeNull();
  });

  it('returns null for non-integer values', () => {
    expect(resolveStaleClaimTtlMs({ SPRITES_INGESTER_STALE_CLAIM_TTL_MS: '1000.5' })).toBeNull();
    expect(
      resolveStaleClaimTtlMs({ SPRITES_INGESTER_STALE_CLAIM_TTL_MS: 'not-a-number' }),
    ).toBeNull();
  });

  it('parses a valid positive integer millisecond value', () => {
    expect(resolveStaleClaimTtlMs({ SPRITES_INGESTER_STALE_CLAIM_TTL_MS: '2700000' })).toBe(
      2_700_000,
    );
  });
});

describe('resolveRunUrl', () => {
  it('returns null when neither explicit nor GitHub env vars are set', () => {
    expect(resolveRunUrl({})).toBeNull();
  });

  it('prefers the explicit SPRITES_INGEST_RUN_URL', () => {
    expect(
      resolveRunUrl({
        SPRITES_INGEST_RUN_URL: 'https://custom.example/run/1',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_RUN_ID: '2',
      }),
    ).toBe('https://custom.example/run/1');
  });

  it('composes the URL from GITHUB_* env vars when explicit is missing', () => {
    expect(
      resolveRunUrl({
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
        GITHUB_RUN_ID: '999',
      }),
    ).toBe('https://github.com/nalfeo/Crawler/actions/runs/999');
  });

  it('returns null if any of the GITHUB_* fallback env vars is missing', () => {
    expect(
      resolveRunUrl({ GITHUB_SERVER_URL: 'x', GITHUB_REPOSITORY: 'y' /* no RUN_ID */ }),
    ).toBeNull();
  });

  it('treats whitespace-only values as unset', () => {
    expect(resolveRunUrl({ SPRITES_INGEST_RUN_URL: '   ' })).toBeNull();
  });
});

describe('formatEnqueueCommentBody', () => {
  it('returns null when there is no run URL to link to', () => {
    expect(formatEnqueueCommentBody({ context: enqueueCtx(), runUrl: null })).toBeNull();
  });

  it('produces a "queued" comment on first enqueue', () => {
    const body = formatEnqueueCommentBody({
      context: enqueueCtx({ issueNumber: 724, name: 'angry-roomba' }),
      runUrl: 'https://github.com/nalfeo/Crawler/actions/runs/999',
    });
    expect(body).not.toBeNull();
    expect(body!).toContain('🎬 Queued for processing');
    expect(body!).toContain('https://github.com/nalfeo/Crawler/actions/runs/999');
    // Fingerprint prefix is included so a human can cross-check the state file.
    expect(body!).toContain('deadbeefcafe');
  });

  it('produces a distinct "re-queued" comment on the reclaim path', () => {
    const body = formatEnqueueCommentBody({
      context: enqueueCtx({ reclaimed: true }),
      runUrl: 'https://github.com/nalfeo/Crawler/actions/runs/999',
    });
    expect(body).not.toBeNull();
    expect(body!).toContain('🔁 Re-queued');
    expect(body!).not.toContain('🎬 Queued for processing');
  });
});
