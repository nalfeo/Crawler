import { describe, expect, it, vi } from 'vitest';
import type { OpenAssetRequestIssue } from '../../../scripts/sprites/sidecar/asset-request-issue-api.js';
import type { IssueIngesterStatus } from '../../../scripts/sprites/sidecar/issue-ingester-controller.js';
import {
  exitCodeForStatus,
  filterIssuesByAllowedAuthors,
  resolveAllowedAuthorLogins,
  resolveRequestedBy,
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
      comment: vi.fn(async () => {}),
    };
    const wrapped = withAuthorAllowList(inner, new Set(['nalfeo']));

    await wrapped.comment(42, 'hello');
    expect(inner.comment).toHaveBeenCalledWith(42, 'hello');
  });
});
