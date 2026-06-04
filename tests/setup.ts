const mockCanvasContext = {
  fillRect: () => {},
  clearRect: () => {},
  drawImage: () => {},
  getImageData: () => ({ data: new Uint8ClampedArray() }),
  putImageData: () => {},
  createImageData: () => ({ data: new Uint8ClampedArray() }),
  setTransform: () => {},
  resetTransform: () => {},
  save: () => {},
  restore: () => {},
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  closePath: () => {},
  stroke: () => {},
  fillText: () => {},
  measureText: () => ({ width: 0 }),
};

const mockRequestAnimationFrame: typeof requestAnimationFrame = (callback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;

const mockCancelAnimationFrame: typeof cancelAnimationFrame = (handle) => {
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

class MockAudio {
  currentTime = 0;
  muted = false;
  paused = true;

  async play(): Promise<void> {
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {}
}

/**
 * Installs minimal browser mocks for headless tests that touch Phaser APIs.
 * Safe to import from individual tests while also serving as a global setup.
 */
export function installHeadlessTestMocks(): void {
  if (typeof HTMLCanvasElement === 'undefined') {
    class MockHTMLCanvasElement {
      getContext(): typeof mockCanvasContext {
        return mockCanvasContext;
      }
    }

    Object.defineProperty(globalThis, 'HTMLCanvasElement', {
      value: MockHTMLCanvasElement,
      configurable: true,
      writable: true,
    });
  }

  HTMLCanvasElement.prototype.getContext = (() =>
    mockCanvasContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  if (typeof requestAnimationFrame === 'undefined') {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: mockRequestAnimationFrame,
      configurable: true,
      writable: true,
    });
  }

  if (typeof cancelAnimationFrame === 'undefined') {
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      value: mockCancelAnimationFrame,
      configurable: true,
      writable: true,
    });
  }

  if (typeof Audio === 'undefined') {
    Object.defineProperty(globalThis, 'Audio', {
      value: MockAudio,
      configurable: true,
      writable: true,
    });
  }
}

installHeadlessTestMocks();
