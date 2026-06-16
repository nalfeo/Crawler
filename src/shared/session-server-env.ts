type SessionEnvMeta = ImportMeta & {
  env?: {
    readonly VITE_SPRITES_SIDECAR_BASE_URL?: string;
  };
};

export function getSpriteSidecarBaseUrl(): string {
  const processValue =
    typeof process !== 'undefined' ? process.env?.VITE_SPRITES_SIDECAR_BASE_URL : undefined;
  if (processValue) {
    return processValue;
  }

  const importMeta = import.meta as SessionEnvMeta;
  return importMeta.env?.VITE_SPRITES_SIDECAR_BASE_URL ?? 'http://127.0.0.1:3010';
}
