import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInputState, type InputState } from '../../src/shared/input.js';

/**
 * Regression tests for InputCapture.
 *
 * The original Phaser-based InputCapture tracked keys on the canvas element.
 * When lil-gui buttons stole focus, keyup events were missed and keys stuck.
 * The fix uses raw window-level DOM listeners so input is focus-independent.
 *
 * These tests ensure:
 * 1. keydown/keyup on window correctly update poll() output
 * 2. Keys never "stick" after keyup
 * 3. Window blur clears all pressed keys
 * 4. destroy() cleans up all listeners
 * 5. The implementation does NOT depend on Phaser's keyboard plugin
 */

// ── Minimal window mock for Node environment ──────────────────────────
// InputCapture only needs addEventListener/removeEventListener/dispatchEvent
// on `window`. We install a lightweight EventTarget as globalThis.window.
const listeners = new Map<string, Set<EventListener>>();

function mockAddEventListener(
  type: string,
  fn: EventListener,
  _options?: boolean | AddEventListenerOptions,
) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(fn);
}
function mockRemoveEventListener(
  type: string,
  fn: EventListener,
  _options?: boolean | EventListenerOptions,
) {
  listeners.get(type)?.delete(fn);
}
function mockDispatchEvent(event: { type: string }): boolean {
  for (const fn of listeners.get(event.type) ?? []) {
    (fn as (e: unknown) => void)(event);
  }
  return true;
}

beforeEach(() => {
  listeners.clear();
  // Install window mock
  (globalThis as unknown as Record<string, unknown>).window = {
    addEventListener: mockAddEventListener,
    removeEventListener: mockRemoveEventListener,
    dispatchEvent: mockDispatchEvent,
    innerWidth: 1000,
  };
});

afterEach(() => {
  listeners.clear();
  delete (globalThis as unknown as Record<string, unknown>).window;
});

// ── Helpers ───────────────────────────────────────────────────────────
function createMockCanvas(): HTMLCanvasElement {
  const canvasListeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type: string, fn: EventListener, _opts?: boolean | AddEventListenerOptions) {
      if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
      canvasListeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: EventListener, _opts?: boolean | EventListenerOptions) {
      canvasListeners.get(type)?.delete(fn);
    },
    dispatchEvent(event: { type: string }): boolean {
      for (const fn of canvasListeners.get(event.type) ?? []) {
        (fn as (e: unknown) => void)(event);
      }
      return true;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLCanvasElement;
}

let mockCanvas: HTMLCanvasElement;

function createMockScene() {
  mockCanvas = createMockCanvas();
  return {
    game: { canvas: mockCanvas },
    input: {
      activePointer: {
        worldX: 0,
        worldY: 0,
        updateWorldPoint: vi.fn(),
        leftButtonDown: () => false,
      },
    },
    cameras: {
      main: {
        getWorldPoint: (x: number, y: number) => ({ x, y }),
      },
    },
    scale: {
      width: 800,
      height: 600,
    },
  } as unknown as import('phaser').Scene;
}

function dispatchCanvasTouch(
  type: string,
  touches: Array<{ id: number; x: number; y: number }>,
): void {
  (mockCanvas as unknown as { dispatchEvent: (e: unknown) => boolean }).dispatchEvent(
    touchEvent(type, touches),
  );
}

function pressKey(code: string): void {
  mockDispatchEvent({ type: 'keydown', code } as unknown as Event);
}

function releaseKey(code: string): void {
  mockDispatchEvent({ type: 'keyup', code } as unknown as Event);
}

function blurWindow(): void {
  mockDispatchEvent({ type: 'blur' } as unknown as Event);
}

function touchEvent(type: string, touches: Array<{ id: number; x: number; y: number }>): Event {
  return {
    type,
    changedTouches: touches.map((touch) => ({
      identifier: touch.id,
      clientX: touch.x,
      clientY: touch.y,
    })),
    preventDefault: () => {},
  } as unknown as Event;
}

function startTouch(id: number, x: number, y: number): void {
  dispatchCanvasTouch('touchstart', [{ id, x, y }]);
}

function moveTouch(id: number, x: number, y: number): void {
  dispatchCanvasTouch('touchmove', [{ id, x, y }]);
}

function endTouch(id: number, x: number, y: number): void {
  dispatchCanvasTouch('touchend', [{ id, x, y }]);
}

function dispatchCanvasPointer(
  type: string,
  opts: { clientX: number; clientY: number; button: number; pointerType: string },
): void {
  (mockCanvas as unknown as { dispatchEvent: (e: unknown) => boolean }).dispatchEvent({
    type,
    clientX: opts.clientX,
    clientY: opts.clientY,
    button: opts.button,
    pointerType: opts.pointerType,
  });
}

describe('InputCapture (raw DOM)', () => {
  let createInputCapture: typeof import('../../src/engine/InputCapture.js').createInputCapture;
  let capture: ReturnType<typeof createInputCapture>;
  let state: InputState;

  beforeEach(async () => {
    // Dynamic import AFTER window mock is installed
    vi.resetModules();
    const mod = await import('../../src/engine/InputCapture.js');
    createInputCapture = mod.createInputCapture;
    capture = createInputCapture(createMockScene());
    state = createInputState();
  });

  afterEach(() => {
    capture?.destroy();
  });

  it('poll returns zero movement when no keys pressed', () => {
    capture.poll(state);
    expect(state.moveX).toBe(0);
    expect(state.moveY).toBe(0);
    expect(state.action).toBe(false);
  });

  it('WASD keys produce correct movement directions', () => {
    pressKey('KeyW');
    capture.poll(state);
    expect(state.moveY).toBe(-1);
    expect(state.moveX).toBe(0);
    releaseKey('KeyW');

    pressKey('KeyS');
    capture.poll(state);
    expect(state.moveY).toBe(1);
    releaseKey('KeyS');

    pressKey('KeyA');
    capture.poll(state);
    expect(state.moveX).toBe(-1);
    releaseKey('KeyA');

    pressKey('KeyD');
    capture.poll(state);
    expect(state.moveX).toBe(1);
    releaseKey('KeyD');
  });

  it('arrow keys produce correct movement directions', () => {
    pressKey('ArrowUp');
    capture.poll(state);
    expect(state.moveY).toBe(-1);
    releaseKey('ArrowUp');

    pressKey('ArrowDown');
    capture.poll(state);
    expect(state.moveY).toBe(1);
    releaseKey('ArrowDown');

    pressKey('ArrowLeft');
    capture.poll(state);
    expect(state.moveX).toBe(-1);
    releaseKey('ArrowLeft');

    pressKey('ArrowRight');
    capture.poll(state);
    expect(state.moveX).toBe(1);
    releaseKey('ArrowRight');
  });

  it('keyup clears movement — keys never stick', () => {
    pressKey('KeyW');
    capture.poll(state);
    expect(state.moveY).toBe(-1);

    pressKey('KeyD');
    capture.poll(state);
    // Both W and D are down → diagonal, normalized
    expect(state.moveX).toBeGreaterThan(0);
    expect(state.moveY).toBeLessThan(0);

    releaseKey('KeyW');
    releaseKey('KeyD');
    capture.poll(state);
    expect(state.moveX).toBe(0);
    expect(state.moveY).toBe(0);
  });

  it('window blur clears all pressed keys', () => {
    pressKey('KeyW');
    capture.poll(state);
    expect(state.moveY).toBe(-1);

    pressKey('KeyA');
    capture.poll(state);
    // Both W and A are down → diagonal
    expect(state.moveY).toBeLessThan(0);
    expect(state.moveX).toBeLessThan(0);

    blurWindow();
    capture.poll(state);
    expect(state.moveX).toBe(0);
    expect(state.moveY).toBe(0);
  });

  it('window blur clears active touches', () => {
    startTouch(1, 100, 200);
    moveTouch(1, 160, 200);
    capture.poll(state);
    expect(state.moveX).toBeGreaterThan(0);

    startTouch(2, 600, 300);
    capture.poll(state);
    expect(state.action).toBe(true);

    blurWindow();
    capture.poll(state);
    expect(state.moveX).toBe(0);
    expect(state.moveY).toBe(0);
    expect(state.action).toBe(false);
  });

  it('Space key triggers action', () => {
    pressKey('Space');
    capture.poll(state);
    expect(state.action).toBe(true);

    releaseKey('Space');
    capture.poll(state);
    expect(state.action).toBe(false);
  });

  it('left-side touch drag controls movement', () => {
    startTouch(1, 100, 200);
    moveTouch(1, 160, 200);

    capture.poll(state);
    expect(state.moveX).toBeGreaterThan(0);
    expect(state.moveY).toBe(0);

    endTouch(1, 160, 200);
    capture.poll(state);
    expect(state.moveX).toBe(0);
    expect(state.moveY).toBe(0);
  });

  it('right-side touch enables action and updates pointer', () => {
    startTouch(2, 600, 300);
    moveTouch(2, 620, 340);

    capture.poll(state);
    expect(state.action).toBe(true);
    expect(state.pointerX).toBe(620);
    expect(state.pointerY).toBe(340);

    endTouch(2, 620, 340);
    capture.poll(state);
    expect(state.action).toBe(false);
  });

  it('diagonal input is normalized', () => {
    pressKey('KeyW');
    pressKey('KeyD');
    capture.poll(state);
    const length = Math.hypot(state.moveX, state.moveY);
    expect(length).toBeCloseTo(1, 5);
    releaseKey('KeyW');
    releaseKey('KeyD');
  });

  it('destroy removes all listeners — keys stop being tracked', () => {
    pressKey('KeyW');
    capture.poll(state);
    expect(state.moveY).toBe(-1);

    capture.destroy();

    // After destroy, new key events should not be tracked
    pressKey('KeyD');
    const freshState = createInputState();
    capture.poll(freshState);
    expect(freshState.moveX).toBe(0);
    expect(freshState.moveY).toBe(0);
  });

  it('opposing keys cancel out', () => {
    pressKey('KeyW');
    pressKey('KeyS');
    capture.poll(state);
    expect(state.moveY).toBe(0);

    pressKey('KeyA');
    pressKey('KeyD');
    capture.poll(state);
    expect(state.moveX).toBe(0);

    releaseKey('KeyW');
    releaseKey('KeyS');
    releaseKey('KeyA');
    releaseKey('KeyD');
  });

  // --- Mouse pointer emulation tests ---
  it('left-side mouse drag controls movement (touch emulation on PC)', () => {
    dispatchCanvasPointer('pointerdown', {
      clientX: 100,
      clientY: 200,
      button: 0,
      pointerType: 'mouse',
    });
    dispatchCanvasPointer('pointermove', {
      clientX: 160,
      clientY: 200,
      button: 0,
      pointerType: 'mouse',
    });

    capture.poll(state);
    expect(state.moveX).toBeGreaterThan(0);
    expect(state.moveY).toBe(0);

    dispatchCanvasPointer('pointerup', {
      clientX: 160,
      clientY: 200,
      button: 0,
      pointerType: 'mouse',
    });
    capture.poll(state);
    expect(state.moveX).toBe(0);
    expect(state.moveY).toBe(0);
  });

  it('right-side mouse click enables action (touch emulation on PC)', () => {
    dispatchCanvasPointer('pointerdown', {
      clientX: 600,
      clientY: 300,
      button: 0,
      pointerType: 'mouse',
    });

    capture.poll(state);
    expect(state.action).toBe(true);

    dispatchCanvasPointer('pointerup', {
      clientX: 600,
      clientY: 300,
      button: 0,
      pointerType: 'mouse',
    });
    capture.poll(state);
    expect(state.action).toBe(false);
  });

  it('right/middle mouse clicks do NOT emulate touch', () => {
    // Right click (button 2) on action zone
    dispatchCanvasPointer('pointerdown', {
      clientX: 600,
      clientY: 300,
      button: 2,
      pointerType: 'mouse',
    });
    capture.poll(state);
    expect(state.action).toBe(false);
    dispatchCanvasPointer('pointerup', {
      clientX: 600,
      clientY: 300,
      button: 2,
      pointerType: 'mouse',
    });

    // Middle click (button 1) on action zone
    dispatchCanvasPointer('pointerdown', {
      clientX: 600,
      clientY: 300,
      button: 1,
      pointerType: 'mouse',
    });
    capture.poll(state);
    expect(state.action).toBe(false);
    dispatchCanvasPointer('pointerup', {
      clientX: 600,
      clientY: 300,
      button: 1,
      pointerType: 'mouse',
    });
  });

  it('pointer events with pointerType "touch" are ignored (handled by touch listeners)', () => {
    dispatchCanvasPointer('pointerdown', {
      clientX: 100,
      clientY: 200,
      button: 0,
      pointerType: 'touch',
    });
    dispatchCanvasPointer('pointermove', {
      clientX: 160,
      clientY: 200,
      button: 0,
      pointerType: 'touch',
    });

    capture.poll(state);
    // Should not register since pointerType is 'touch' — real touch events handle those
    expect(state.moveX).toBe(0);
    expect(state.moveY).toBe(0);
  });
});

describe('InputCapture architectural guard', () => {
  it('does not import Phaser keyboard types for key tracking', async () => {
    // @ts-expect-error Node fs module available at runtime but not in tsconfig types
    const { readFileSync } = await import('fs');
    const source = (readFileSync as (p: string, e: string) => string)(
      'src/engine/InputCapture.ts',
      'utf-8',
    );

    // Must NOT use Phaser.Input.Keyboard (the focus-dependent API)
    expect(source).not.toContain('Phaser.Input.Keyboard');
    expect(source).not.toContain('createCursorKeys');
    expect(source).not.toContain('addKeys');
    expect(source).not.toContain('addKey');
    expect(source).not.toContain('.isDown');

    // MUST use window-level event listeners
    expect(source).toContain("window.addEventListener('keydown'");
    expect(source).toContain("window.addEventListener('keyup'");
    expect(source).toContain("window.addEventListener('blur'");
  });
});
