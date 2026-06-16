export interface SessionServerPorts {
  readonly gamePort: number;
  readonly labPort: number;
  readonly devtoolsPort: number;
  readonly sidecarPort: number;
  readonly gameBaseUrl: string;
  readonly labBaseUrl: string;
  readonly devtoolsBaseUrl: string;
  readonly sidecarBaseUrl: string;
}

export interface SessionServerPortOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}

export function normalizeWorkspaceKey(cwd?: string): string;
export function hashWorkspaceKey(key: string): number;
export function deriveSessionPortBlock(cwd?: string): number;
export function getSessionServerPorts(options?: SessionServerPortOptions): SessionServerPorts;
export function getVitePortForMode(mode: string, options?: SessionServerPortOptions): number;
