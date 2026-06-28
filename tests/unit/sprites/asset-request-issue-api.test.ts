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
  it('passes an explicit limit when listing open asset-request issues', async () => {
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
        'number,body',
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
      },
    ]);
  });
});
