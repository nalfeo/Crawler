/**
 * GameOverUI — death screen overlay shown when the player is slain.
 *
 * Triggered by world.state === 'game_over' when the player's HP hits zero.
 * Offers Restart and Quit actions. Designed for future extensibility so
 * options like "resurrect with penalty" or skill-triggered revivals can
 * be added as additional ModalPickerOption entries.
 */
import Phaser from 'phaser';
import { createModalPickerUI } from './ModalPickerUI.js';

export type GameOverOption = 'restart' | 'quit';

export interface GameOverUIHooks {
  onRestart: () => void;
  onQuit: () => void;
}

export function createGameOverUI(
  scene: Phaser.Scene,
  hooks: GameOverUIHooks,
): {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
} {
  // Reuse the existing ModalPickerUI for consistent look, keyboard nav, and touch support.
  const picker = createModalPickerUI(scene);
  let visible = false;

  return {
    show(): void {
      if (visible) {
        return;
      }
      visible = true;
      picker.open(
        {
          title: 'Game Over',
          subtitle: 'You have been slain.',
          options: [
            {
              id: 'restart' as GameOverOption,
              label: '↺ Restart',
              description: 'Start over from the beginning.',
            },
            {
              id: 'quit' as GameOverOption,
              label: '← Quit',
              description: 'Return to the title screen.',
            },
          ],
          allowCancel: false,
        },
        {
          onConfirm: ({ option }) => {
            visible = false;
            if (option.id === 'restart') {
              hooks.onRestart();
            } else if (option.id === 'quit') {
              hooks.onQuit();
            }
          },
        },
      );
    },
    hide(): void {
      if (!visible) {
        return;
      }
      visible = false;
      picker.close();
    },
    isVisible(): boolean {
      return visible;
    },
    destroy(): void {
      visible = false;
      picker.destroy();
    },
  };
}
