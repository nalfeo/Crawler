import Phaser from 'phaser';
import { normalizeInputDirection, type InputState } from '../shared/input.js';

type MovementKeys = {
  up?: Phaser.Input.Keyboard.Key;
  down?: Phaser.Input.Keyboard.Key;
  left?: Phaser.Input.Keyboard.Key;
  right?: Phaser.Input.Keyboard.Key;
};

function isKeyDown(key: Phaser.Input.Keyboard.Key | undefined): boolean {
  return key?.isDown ?? false;
}

function destroyKey(key: Phaser.Input.Keyboard.Key | undefined): void {
  key?.destroy();
}

export function createInputCapture(scene: Phaser.Scene): {
  /** Read current hardware state into the InputState */
  poll(state: InputState): void;
  destroy(): void;
} {
  const keyboard = scene.input.keyboard;
  const cursors = keyboard?.createCursorKeys();
  const wasd = keyboard?.addKeys({
    up: Phaser.Input.Keyboard.KeyCodes.W,
    down: Phaser.Input.Keyboard.KeyCodes.S,
    left: Phaser.Input.Keyboard.KeyCodes.A,
    right: Phaser.Input.Keyboard.KeyCodes.D,
  }) as MovementKeys | undefined;
  const actionKey = keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

  return {
    poll(state: InputState): void {
      const moveX = Number(isKeyDown(cursors?.right) || isKeyDown(wasd?.right))
        - Number(isKeyDown(cursors?.left) || isKeyDown(wasd?.left));
      const moveY = Number(isKeyDown(cursors?.down) || isKeyDown(wasd?.down))
        - Number(isKeyDown(cursors?.up) || isKeyDown(wasd?.up));
      const pointer = scene.input.activePointer;
      const normalized = normalizeInputDirection(moveX, moveY);

      state.moveX = normalized.moveX;
      state.moveY = normalized.moveY;
      state.action = Boolean(actionKey?.isDown) || pointer.leftButtonDown();

      pointer.updateWorldPoint(scene.cameras.main);
      state.pointerX = pointer.worldX;
      state.pointerY = pointer.worldY;
    },
    destroy(): void {
      destroyKey(cursors?.up);
      destroyKey(cursors?.down);
      destroyKey(cursors?.left);
      destroyKey(cursors?.right);
      destroyKey(wasd?.up);
      destroyKey(wasd?.down);
      destroyKey(wasd?.left);
      destroyKey(wasd?.right);
      destroyKey(actionKey);
    },
  };
}
