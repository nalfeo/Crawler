export type MobileMoveMode = 'joystick' | 'follow';

export interface GlobalControlsConfig {
  mobileMoveMode: MobileMoveMode;
}

const STORAGE_KEY = 'crawler:global-controls-config';

const DEFAULT_CONFIG: GlobalControlsConfig = {
  mobileMoveMode: 'joystick',
};

let currentConfig = loadConfig();

function sanitizeMoveMode(value: unknown): MobileMoveMode {
  return value === 'follow' ? 'follow' : 'joystick';
}

function loadConfig(): GlobalControlsConfig {
  if (typeof window === 'undefined' || !('localStorage' in window)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<GlobalControlsConfig>;
    return {
      mobileMoveMode: sanitizeMoveMode(parsed.mobileMoveMode),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function persistConfig(config: GlobalControlsConfig): void {
  if (typeof window === 'undefined' || !('localStorage' in window)) {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage failures.
  }
}

export function getGlobalControlsConfig(): GlobalControlsConfig {
  return currentConfig;
}

export function setGlobalControlsConfig(next: Partial<GlobalControlsConfig>): GlobalControlsConfig {
  currentConfig = {
    ...currentConfig,
    mobileMoveMode: sanitizeMoveMode(next.mobileMoveMode),
  };
  persistConfig(currentConfig);
  return currentConfig;
}
