type SessionEnvMeta = ImportMeta & {
  env?: {
    readonly VITE_SPRITES_SIDECAR_BASE_URL?: string;
  };
};

declare const __CRAWLER_SPRITES_SIDECAR_BASE_URL__: string | undefined;

const LEGACY_SPRITE_SIDECAR_FALLBACK = 'http://127.0.0.1:3010';
let didWarnMissingSidecarBaseUrl = false;

function warnMissingSidecarBaseUrl(): void {
  if (didWarnMissingSidecarBaseUrl || typeof console === 'undefined') {
    return;
  }
  didWarnMissingSidecarBaseUrl = true;
  console.warn(
    '[session-server] VITE_SPRITES_SIDECAR_BASE_URL is missing; falling back to legacy http://127.0.0.1:3010',
  );
}

export function getSpriteSidecarBaseUrl(): string {
  if (typeof __CRAWLER_SPRITES_SIDECAR_BASE_URL__ === 'string') {
    const injectedValue = __CRAWLER_SPRITES_SIDECAR_BASE_URL__.trim();
    if (injectedValue.length > 0) {
      return injectedValue;
    }
  }

  const processValue =
    typeof process !== 'undefined' ? process.env?.VITE_SPRITES_SIDECAR_BASE_URL : undefined;
  if (processValue) {
    return processValue;
  }

  const importMeta = import.meta as SessionEnvMeta;
  const importMetaValue = importMeta.env?.VITE_SPRITES_SIDECAR_BASE_URL;
  if (importMetaValue) {
    return importMetaValue;
  }
  warnMissingSidecarBaseUrl();
  return LEGACY_SPRITE_SIDECAR_FALLBACK;
}
