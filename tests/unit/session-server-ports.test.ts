import { describe, expect, it } from 'vitest';

import {
  deriveSessionPortBlock,
  getSessionServerPorts,
  getVitePortForMode,
  hashWorkspaceKey,
  normalizeWorkspaceKey,
} from '../../scripts/shared/session-server-ports.js';

describe('session server ports', () => {
  it('derives a stable normalized workspace key', () => {
    expect(normalizeWorkspaceKey('C:/Repo/Crawler/Worktree')).toBe('c:\\repo\\crawler\\worktree');
  });

  it('hashes normalized workspace keys deterministically', () => {
    const key = normalizeWorkspaceKey('C:/Repo/Crawler/alpha');
    expect(hashWorkspaceKey(key)).toBe(hashWorkspaceKey(key));
    expect(hashWorkspaceKey(key)).toBe(hashWorkspaceKey('c:\\repo\\crawler\\alpha'));
  });

  it('uses deterministic ports for the same workspace', () => {
    const first = getSessionServerPorts({ cwd: 'C:\\Repo\\Crawler\\alpha', env: {} });
    const second = getSessionServerPorts({ cwd: 'C:\\Repo\\Crawler\\alpha', env: {} });

    expect(first).toEqual(second);
  });

  it('separates modes within a workspace port block', () => {
    const ports = getSessionServerPorts({ cwd: 'C:\\Repo\\Crawler\\alpha', env: {} });

    expect(ports.labPort).toBe(ports.gamePort + 1);
    expect(ports.devtoolsPort).toBe(ports.gamePort + 2);
    expect(ports.e2eLabPort).toBe(ports.gamePort + 3);
    expect(ports.sidecarPort).toBe(ports.gamePort + 10);
    expect(ports.gameBaseUrl).toBe(`http://localhost:${ports.gamePort}`);
    expect(ports.labBaseUrl).toBe(`http://localhost:${ports.labPort}`);
    expect(ports.devtoolsBaseUrl).toBe(`http://localhost:${ports.devtoolsPort}`);
    expect(ports.e2eLabBaseUrl).toBe(`http://127.0.0.1:${ports.e2eLabPort}`);
    expect(ports.sidecarBaseUrl).toBe(`http://127.0.0.1:${ports.sidecarPort}`);
  });

  // The e2e suite spawns its own `--strictPort` lab server. Sharing the
  // interactive lab port would let `npm run lab` steal it, after which the
  // suite silently ran against the long-lived server instead of its own.
  it('gives the e2e lab server its own port, distinct from the interactive lab', () => {
    const ports = getSessionServerPorts({ cwd: 'C:\\Repo\\Crawler\\alpha', env: {} });

    expect(ports.e2eLabPort).not.toBe(ports.labPort);
    expect(ports.e2eLabPort).not.toBe(ports.gamePort);
    expect(ports.e2eLabPort).not.toBe(ports.devtoolsPort);
    expect(ports.e2eLabPort).not.toBe(ports.sidecarPort);
  });

  it('gives separate worktrees separate e2e lab ports', () => {
    const alpha = getSessionServerPorts({ cwd: 'C:\\Repo\\Crawler\\alpha', env: {} });
    const beta = getSessionServerPorts({ cwd: 'C:\\Repo\\Crawler\\beta', env: {} });

    expect(alpha.e2eLabPort).not.toBe(beta.e2eLabPort);
  });

  it('changes port blocks across workspaces', () => {
    const alpha = deriveSessionPortBlock('C:\\Repo\\Crawler\\alpha');
    const beta = deriveSessionPortBlock('C:\\Repo\\Crawler\\beta');

    expect(alpha).not.toBe(beta);
  });

  it('honors explicit environment overrides', () => {
    const ports = getSessionServerPorts({
      cwd: 'C:\\Repo\\Crawler\\alpha',
      env: {
        CRAWLER_DEV_PORT: '4990',
        CRAWLER_LAB_PORT: '4991',
        CRAWLER_DEVTOOLS_PORT: '4992',
        CRAWLER_E2E_LAB_PORT: '4993',
        SPRITES_SIDECAR_PORT: '4999',
      },
    });

    expect(ports.gamePort).toBe(4990);
    expect(ports.labPort).toBe(4991);
    expect(ports.devtoolsPort).toBe(4992);
    expect(ports.e2eLabPort).toBe(4993);
    expect(ports.sidecarPort).toBe(4999);
  });

  it('maps vite mode to the right port', () => {
    const options = { cwd: 'C:\\Repo\\Crawler\\alpha', env: {} };

    expect(getVitePortForMode('lab', options)).toBe(getSessionServerPorts(options).labPort);
    expect(getVitePortForMode('devtools', options)).toBe(
      getSessionServerPorts(options).devtoolsPort,
    );
    expect(getVitePortForMode('development', options)).toBe(
      getSessionServerPorts(options).gamePort,
    );
  });
});
