import { describe, expect, it } from 'vitest';

import {
  appendLaunchContextToUrl,
  describeLaunchContext,
  mergeLaunchContextSearch,
  normalizeHttpUrl,
  parseLaunchContext,
} from '../../../src/shared/launch-context.js';

describe('launch context parsing', () => {
  it('returns null when no launch context is present', () => {
    expect(parseLaunchContext('')).toBeNull();
  });

  it('parses launch session, branch, and PR metadata from the query string', () => {
    const context = parseLaunchContext(
      '?launchSession=worktree-12&launchBranch=feature/popup&launchPrNumber=42&launchPrTitle=Add%20popup&launchPrUrl=https%3A%2F%2Fexample.com%2Fpr%2F42',
    );

    expect(context).toEqual({
      sessionName: 'worktree-12',
      branchName: 'feature/popup',
      pullRequestNumber: 42,
      pullRequestTitle: 'Add popup',
      pullRequestUrl: 'https://example.com/pr/42',
    });
  });

  it('formats the launch context summary for the popup', () => {
    expect(
      describeLaunchContext({
        sessionName: 'worktree-12',
        branchName: 'feature/popup',
        pullRequestNumber: 42,
        pullRequestTitle: 'Add popup',
        pullRequestUrl: 'https://example.com/pr/42',
      }),
    ).toEqual(['Session: worktree-12', 'Branch: feature/popup', 'PR #42 — Add popup']);
  });

  it('merges launch context into existing search parameters', () => {
    expect(
      mergeLaunchContextSearch('?page=sprite-review', {
        sessionName: 'worktree-12',
        branchName: 'feature/popup',
        pullRequestNumber: 42,
        pullRequestTitle: 'Add popup',
        pullRequestUrl: 'https://example.com/pr/42',
      }),
    ).toBe(
      '?page=sprite-review&launchSession=worktree-12&launchBranch=feature%2Fpopup&launchPrNumber=42&launchPrTitle=Add+popup&launchPrUrl=https%3A%2F%2Fexample.com%2Fpr%2F42',
    );
  });

  it('preserves launch context when appending to a URL', () => {
    const url = appendLaunchContextToUrl(new URL('http://127.0.0.1:4178/lab.html?lab=damage-lab'), {
      sessionName: 'worktree-12',
      branchName: 'feature/popup',
      pullRequestNumber: 42,
      pullRequestTitle: 'Add popup',
      pullRequestUrl: 'https://example.com/pr/42',
    });

    expect(url.toString()).toBe(
      'http://127.0.0.1:4178/lab.html?lab=damage-lab&launchSession=worktree-12&launchBranch=feature%2Fpopup&launchPrNumber=42&launchPrTitle=Add+popup&launchPrUrl=https%3A%2F%2Fexample.com%2Fpr%2F42',
    );
  });

  it('rejects unsafe PR URLs', () => {
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeHttpUrl('https://example.com/pr/42')).toBe('https://example.com/pr/42');
  });
});
