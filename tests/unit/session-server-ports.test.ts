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
    expect(ports.sidecarPort).toBe(ports.gamePort + 10);
    expect(ports.gameBaseUrl).toBe(`http://localhost:${ports.gamePort}`);
    expect(ports.labBaseUrl).toBe(`http://localhost:${ports.labPort}`);
    expect(ports.devtoolsBaseUrl).toBe(`http://localhost:${ports.devtoolsPort}`);
    expect(ports.sidecarBaseUrl).toBe(`http://127.0.0.1:${ports.sidecarPort}`);
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
        SPRITES_SIDECAR_PORT: '4999',
      },
    });

    expect(ports.gamePort).toBe(4990);
    expect(ports.labPort).toBe(4991);
    expect(ports.devtoolsPort).toBe(4992);
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
