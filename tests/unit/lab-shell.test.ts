import { describe, expect, it } from 'vitest';
import {
  initLabShell,
  setControlsCollapsedState,
  type LabShellElements,
} from '../../src/labs/lab-shell.js';

class ClassListMock {
  private readonly tokens = new Set<string>();

  toggle(token: string, force?: boolean): boolean {
    const enabled = force ?? !this.tokens.has(token);
    if (enabled) {
      this.tokens.add(token);
    } else {
      this.tokens.delete(token);
    }
    return enabled;
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

class ButtonMock {
  readonly classList = new ClassListMock();
  readonly attributes = new Map<string, string>();
  hidden = false;
  textContent: string | null = null;

  private clickListener?: () => void;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: 'click', listener: () => void): void {
    if (type === 'click') {
      this.clickListener = listener;
    }
  }

  click(): void {
    this.clickListener?.();
  }
}

function createElements(): {
  elements: LabShellElements;
  controlsPanel: { classList: ClassListMock };
  controlsToggle: ButtonMock;
  body: { classList: ClassListMock };
} {
  const controlsPanel = { classList: new ClassListMock() };
  const controlsToggle = new ButtonMock();
  const body = { classList: new ClassListMock() };

  return {
    elements: {
      body,
      controlsPanel,
      controlsToggle,
    },
    controlsPanel,
    controlsToggle,
    body,
  };
}

function createStorage(initial: Record<string, string> = {}): {
  data: Map<string, string>;
  storage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    },
  };
}

describe('lab shell', () => {
  it('updates the controls toggle affordance when collapsing the panel', () => {
    const { elements, controlsPanel, controlsToggle } = createElements();

    setControlsCollapsedState(elements, true);
    expect(controlsPanel.classList.contains('collapsed')).toBe(true);
    expect(controlsToggle.classList.contains('collapsed')).toBe(true);
    expect(controlsToggle.textContent).toBe('‹');
    expect(controlsToggle.attributes.get('aria-expanded')).toBe('false');

    setControlsCollapsedState(elements, false);
    expect(controlsPanel.classList.contains('collapsed')).toBe(false);
    expect(controlsToggle.classList.contains('collapsed')).toBe(false);
    expect(controlsToggle.textContent).toBe('›');
    expect(controlsToggle.attributes.get('aria-expanded')).toBe('true');
  });

  it('restores and persists the collapsed state for active labs', () => {
    const { elements, controlsToggle } = createElements();
    const { data, storage } = createStorage({
      'lab-controls-collapsed': 'true',
    });

    initLabShell({
      hasActiveLab: true,
      elements,
      storage,
    });

    expect(controlsToggle.textContent).toBe('‹');

    controlsToggle.click();
    expect(data.get('lab-controls-collapsed')).toBe('false');
  });
});
