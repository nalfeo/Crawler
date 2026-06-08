export type LabViewportPreset = 'desktop' | 'iphone-landscape';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

type ClassListLike = Pick<DOMTokenList, 'toggle'>;

type ClassTarget = {
  classList: ClassListLike;
};

type ButtonTarget = ClassTarget & {
  hidden: boolean | string;
  textContent: string | null;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (type: 'click', listener: () => void) => void;
};

export interface LabShellElements {
  body: ClassTarget;
  controlsPanel: ClassTarget;
  controlsToggle: ButtonTarget;
  viewportToggle: ButtonTarget;
}

export interface InitLabShellOptions {
  hasActiveLab: boolean;
  allowViewportPreset?: boolean;
  elements?: LabShellElements;
  storage?: StorageLike;
}

const CONTROLS_COLLAPSED_KEY = 'lab-controls-collapsed';
const VIEWPORT_PRESET_KEY = 'lab-viewport-preset';
const CONTROLS_COLLAPSED_CLASS = 'collapsed';
const IPHONE_VIEWPORT_CLASS = 'lab-shell--iphone-landscape';
const DESKTOP_POINTER_QUERY = '(min-width: 901px) and (pointer: fine)';

function readCollapsed(storage: StorageLike): boolean {
  return storage.getItem(CONTROLS_COLLAPSED_KEY) === 'true';
}

function readViewportPreset(storage: StorageLike): LabViewportPreset {
  return storage.getItem(VIEWPORT_PRESET_KEY) === 'iphone-landscape'
    ? 'iphone-landscape'
    : 'desktop';
}

function getStorage(): StorageLike {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('Lab shell requires localStorage.');
  }
  return window.localStorage;
}

function getElements(): LabShellElements {
  const controlsPanel = document.getElementById('lab-controls');
  const controlsToggle = document.getElementById('controls-toggle');
  const viewportToggle = document.getElementById('viewport-toggle');

  if (
    !controlsPanel ||
    !(controlsToggle instanceof HTMLButtonElement) ||
    !(viewportToggle instanceof HTMLButtonElement)
  ) {
    throw new Error('Lab shell controls are missing.');
  }

  return {
    body: document.body,
    controlsPanel,
    controlsToggle,
    viewportToggle,
  };
}

export function shouldAllowViewportPreset(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }

  return window.matchMedia(DESKTOP_POINTER_QUERY).matches;
}

export function setControlsCollapsedState(elements: LabShellElements, collapsed: boolean): void {
  elements.controlsPanel.classList.toggle(CONTROLS_COLLAPSED_CLASS, collapsed);
  elements.controlsToggle.classList.toggle(CONTROLS_COLLAPSED_CLASS, collapsed);
  elements.controlsToggle.setAttribute('aria-expanded', String(!collapsed));
  elements.controlsToggle.setAttribute(
    'aria-label',
    collapsed ? 'Expand config panel' : 'Collapse config panel',
  );
  elements.controlsToggle.textContent = collapsed ? '‹' : '›';
}

export function setViewportPresetState(
  elements: LabShellElements,
  preset: LabViewportPreset,
): void {
  const enabled = preset === 'iphone-landscape';
  elements.body.classList.toggle(IPHONE_VIEWPORT_CLASS, enabled);
  elements.viewportToggle.textContent = `iPhone Landscape: ${enabled ? 'On' : 'Off'}`;
  elements.viewportToggle.setAttribute('aria-pressed', String(enabled));
  elements.viewportToggle.setAttribute(
    'aria-label',
    enabled ? 'Disable iPhone landscape viewport' : 'Enable iPhone landscape viewport',
  );
}

export function initLabShell(options: InitLabShellOptions): void {
  const storage = options.storage ?? getStorage();
  const elements = options.elements ?? getElements();
  const allowViewportPreset = options.allowViewportPreset ?? shouldAllowViewportPreset();

  let controlsCollapsed = readCollapsed(storage);
  setControlsCollapsedState(elements, controlsCollapsed);

  elements.controlsToggle.addEventListener('click', () => {
    controlsCollapsed = !controlsCollapsed;
    setControlsCollapsedState(elements, controlsCollapsed);
    storage.setItem(CONTROLS_COLLAPSED_KEY, String(controlsCollapsed));
  });

  const showViewportToggle = options.hasActiveLab && allowViewportPreset;
  elements.viewportToggle.hidden = !showViewportToggle;

  let viewportPreset: LabViewportPreset =
    options.hasActiveLab && allowViewportPreset ? readViewportPreset(storage) : 'desktop';
  setViewportPresetState(elements, viewportPreset);

  elements.viewportToggle.addEventListener('click', () => {
    if (!showViewportToggle) return;

    viewportPreset = viewportPreset === 'desktop' ? 'iphone-landscape' : 'desktop';
    setViewportPresetState(elements, viewportPreset);
    storage.setItem(VIEWPORT_PRESET_KEY, viewportPreset);
  });
}
