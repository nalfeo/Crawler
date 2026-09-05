export const EXPECTED_SIDECAR_VERSION = '0.3.0-managed';

export function isSidecarReady(payload) {
  return payload?.status === 'ok' && payload.version === EXPECTED_SIDECAR_VERSION;
}
