export const SPRITE_SIDECAR_SERVICE_VERSION = '0.3.0-managed';
export const SIDECAR_SHUTDOWN_HEADER = 'x-crawler-sidecar-token';

export interface SidecarServiceIdentity {
  readonly managed: boolean;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  /** Git HEAD commit hash of the checkout that started this service. */
  readonly codeProvenance?: string;
}

export interface SidecarServiceControl {
  readonly identity: SidecarServiceIdentity;
  readonly shutdownToken: string;
  readonly requestShutdown: () => void;
}
