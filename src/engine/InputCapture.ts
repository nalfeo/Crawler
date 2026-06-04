import type Phaser from 'phaser';
import { normalizeInputDirection, type InputState } from '../shared/input.js';

/**
 * Raw DOM keyboard tracker that listens on `window`.
 * Phaser's built-in keyboard plugin is tied to canvas focus — when lil-gui
 * buttons steal focus, keyup events are missed and keys stick.  This
 * implementation is completely focus-independent.
 */
export function createInputCapture(scene: Phaser.Scene): {
  /** Read current hardware state into the InputState */
  poll(state: InputState): void;
  destroy(): void;
} {
  const keysDown = new Set<string>();

  const onKeyDown = (e: KeyboardEvent) => {
    keysDown.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keysDown.delete(e.code);
  };
  // Clear all keys when the window loses focus (alt-tab, etc.)
  const onBlur = () => {
    keysDown.clear();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  return {
    poll(state: InputState): void {
      const moveX =
        Number(keysDown.has('ArrowRight') || keysDown.has('KeyD')) -
        Number(keysDown.has('ArrowLeft') || keysDown.has('KeyA'));
      const moveY =
        Number(keysDown.has('ArrowDown') || keysDown.has('KeyS')) -
        Number(keysDown.has('ArrowUp') || keysDown.has('KeyW'));
      const normalized = normalizeInputDirection(moveX, moveY);

      state.moveX = normalized.moveX;
      state.moveY = normalized.moveY;
      state.action = keysDown.has('Space');

      const pointer = scene.input.activePointer;
      pointer.updateWorldPoint(scene.cameras.main);
      state.pointerX = pointer.worldX;
      state.pointerY = pointer.worldY;
    },
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      keysDown.clear();
    },
  };
}
