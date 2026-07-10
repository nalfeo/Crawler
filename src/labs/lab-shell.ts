export type LabViewportPreset = 'desktop';

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
}

export interface InitLabShellOptions {
  hasActiveLab: boolean;
  elements?: LabShellElements;
  storage?: StorageLike;
}

const CONTROLS_COLLAPSED_KEY = 'lab-controls-collapsed';
const CONTROLS_COLLAPSED_CLASS = 'collapsed';

function readCollapsed(storage: StorageLike): boolean {
  return storage.getItem(CONTROLS_COLLAPSED_KEY) === 'true';
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

  if (!controlsPanel || !(controlsToggle instanceof HTMLButtonElement)) {
    throw new Error('Lab shell controls are missing.');
  }

  return {
    body: document.body,
    controlsPanel,
    controlsToggle,
  };
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

export function initLabShell(options: InitLabShellOptions): void {
  const storage = options.storage ?? getStorage();
  const elements = options.elements ?? getElements();

  let controlsCollapsed = readCollapsed(storage);
  setControlsCollapsedState(elements, controlsCollapsed);

  elements.controlsToggle.addEventListener('click', () => {
    controlsCollapsed = !controlsCollapsed;
    setControlsCollapsedState(elements, controlsCollapsed);
    storage.setItem(CONTROLS_COLLAPSED_KEY, String(controlsCollapsed));
  });
}
