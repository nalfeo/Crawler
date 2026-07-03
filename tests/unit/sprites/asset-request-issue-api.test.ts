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

describe('createGhAssetRequestIssueApi', () => {
  it('passes an explicit limit when listing open asset-request issues and parses author.login', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          body: [
            '### Name',
            'bone-dagger',
            '',
            '### Brief',
            'A chipped bone dagger with twine-wrapped handle.',
          ].join('\n'),
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
        body: [
          '### Name',
          'bone-dagger',
          '',
          '### Brief',
          'A chipped bone dagger with twine-wrapped handle.',
        ].join('\n'),
        authorLogin: 'nalfeo',
      },
    ]);
  });

  it('leaves authorLogin undefined when gh omits or malforms the author field', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 43,
          body: ['### Name', 'iron-sword', '', '### Brief', 'A short iron sword.'].join('\n'),
          // missing author entirely
        },
        {
          number: 44,
          body: ['### Name', 'copper-shield', '', '### Brief', 'A small round copper shield.'].join(
            '\n',
          ),
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
});
