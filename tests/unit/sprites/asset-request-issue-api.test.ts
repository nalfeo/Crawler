import { describe, expect, it, vi } from 'vitest';

const { execFileAsyncMock, execFileMock } = vi.hoisted(() => {
  const execFileAsyncMock = vi.fn();
  const execFileMock = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock,
  });
  return { execFileAsyncMock, execFileMock };
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { createGhAssetRequestIssueApi } from '../../../scripts/sprites/sidecar/asset-request-issue-api.js';

/** Minimal valid issue-form body. */
function validBody(name: string, brief: string): string {
  return ['### Name', name, '', '### Brief', brief].join('\n');
}

/** Body with an invalid explicit size (triggers AssetRequestValidationError). */
function invalidSizeBody(name: string, brief: string): string {
  return ['### Name', name, '', '### Brief', brief, '', '### Size (optional)', 'huge'].join('\n');
}

describe('createGhAssetRequestIssueApi', () => {
  it('passes an explicit limit when listing open asset-request issues and parses author.login', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          body: validBody('bone-dagger', 'A chipped bone dagger with twine-wrapped handle.'),
          author: { login: 'nalfeo', id: 'MDQ6', is_bot: false, name: '' },
        },
      ]),
      stderr: '',
    });

    const issues = await createGhAssetRequestIssueApi('/repo').listOpenAssetRequestIssues();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      [
        'issue',
        'list',
        '--label',
        'asset-request',
        '--state',
        'open',
        '--limit',
        '200',
        '--json',
        'number,body,author',
      ],
      { cwd: '/repo' },
    );
    expect(issues).toEqual([
      {
        number: 42,
        body: validBody('bone-dagger', 'A chipped bone dagger with twine-wrapped handle.'),
        authorLogin: 'nalfeo',
      },
    ]);
  });

  it('leaves authorLogin undefined when gh omits or malforms the author field', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 43,
          body: validBody('iron-sword', 'A short iron sword.'),
          // missing author entirely
        },
        {
          number: 44,
          body: validBody('copper-shield', 'A small round copper shield.'),
          author: { name: 'no-login' },
        },
      ]),
      stderr: '',
    });

    const issues = await createGhAssetRequestIssueApi('/repo').listOpenAssetRequestIssues();

    expect(issues).toHaveLength(2);
    expect(issues[0]?.authorLogin).toBeUndefined();
    expect(issues[1]?.authorLogin).toBeUndefined();
  });

  it('skips an issue with invalid size and logs to stderr, leaving other issues intact', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 100,
          body: invalidSizeBody('batfolk-boss', 'An aristocratic batfolk crime boss.'),
        },
        {
          number: 101,
          body: validBody('iron-sword', 'A short iron sword blade.'),
        },
      ]),
      stderr: '',
    });

    const issues = await createGhAssetRequestIssueApi('/repo').listOpenAssetRequestIssues();

    // Invalid-size issue is skipped, not fatal.
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(101);
    // Diagnostic written to stderr with the issue number.
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('#100'));
    stderrWrite.mockRestore();
  });

  it('does not suppress non-AssetRequestValidationError exceptions from parseAssetRequestIssueBody', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { number: 200, body: validBody('iron-shield', 'A small round iron shield.') },
      ]),
      stderr: '',
    });
    const unexpected = new Error('unexpected parser failure');
    const parseIssue = vi.fn(() => {
      throw unexpected;
    });

    await expect(
      createGhAssetRequestIssueApi('/repo', parseIssue).listOpenAssetRequestIssues(),
    ).rejects.toBe(unexpected);
  });
});
