/**
 * AI Runner Lab
 *
 * Watch the AI play the game in real-time. Useful for:
 * - Debugging AI behavior
 * - Tuning AI parameters
 * - Showcasing the AI player
 * - Comparing AI vs human performance
 */
import Phaser from 'phaser';
import { BootScene, MainGameScene } from '../../engine/index.js';
import { BehaviorTreeAI } from '../../game/ai/index.js';
import { createInputState } from '../../shared/input.js';
import type { GameWorld } from '../../core/world.js';

const AI_SEED = 42;

export default {
  id: 'ai-runner',
  name: 'AI Runner',
  description: 'Watch the AI play the game',
  create(canvas: HTMLElement, controls: HTMLElement): () => void {
    // Create AI input provider
    const ai = new BehaviorTreeAI({
      seed: AI_SEED,
      aggression: 1,
      retreatThreshold: 0.3,
      debug: true,
    });

    const inputState = createInputState();

    // Custom input provider that uses AI instead of human input
    const aiInputProvider = {
      poll(state: typeof inputState): void {
        // AI needs access to world state - we'll get it from the scene
        const scene = game.scene.getScene('MainGameScene') as MainGameScene | null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (scene && (scene as any).world) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const world = (scene as any).world as GameWorld;
          ai.poll(state, world);

          // Copy AI decisions to our input state
          state.moveX = inputState.moveX;
          state.moveY = inputState.moveY;
          state.action = inputState.action;
          state.pointerX = inputState.pointerX;
          state.pointerY = inputState.pointerY;
        } else {
          state.moveX = 0;
          state.moveY = 0;
          state.action = false;
        }
      },
      destroy(): void {
        // Nothing to clean up
      },
    };

    // Create Phaser game with custom input provider
    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.WEBGL,
      parent: canvas,
      width: 1280,
      height: 720,
      backgroundColor: '#1a1a2e',
      pixelArt: true,
      scene: [BootScene, MainGameScene],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      physics: {
        default: 'arcade',
        arcade: {
          gravity: { x: 0, y: 0 },
          debug: false,
        },
      },
    };

    const game = new Phaser.Game(config);

    // Override input capture in MainGameScene
    game.events.once('ready', () => {
      const scene = game.scene.getScene('MainGameScene') as MainGameScene | null;
      if (scene) {
        // Replace the input capture with our AI provider
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (scene as any).inputCapture = aiInputProvider;
      }
    });

    // Create controls UI
    controls.innerHTML = `
      <div style="font-family: monospace; padding: 12px;">
        <h3 style="margin: 0 0 12px 0;">AI Runner Lab</h3>
        <div id="ai-info" style="font-size: 12px; line-height: 1.6;">
          <div>Seed: ${AI_SEED}</div>
          <div>Watching AI play...</div>
          <div id="ai-decision" style="margin-top: 8px; padding: 8px; background: #2a2a4e; border-radius: 4px;">
            <div><strong>State:</strong> <span id="ai-state">-</span></div>
            <div><strong>Reason:</strong> <span id="ai-reason">-</span></div>
            <div><strong>Target:</strong> <span id="ai-target">-</span></div>
          </div>
          <div style="margin-top: 12px; padding: 8px; background: #1a1a3e; border-radius: 4px; font-size: 11px;">
            <div><strong>Tips:</strong></div>
            <div>• Watch the AI explore and engage enemies</div>
            <div>• AI uses same InputState as human players</div>
            <div>• No special programmatic access</div>
          </div>
        </div>
      </div>
    `;

    // Update AI decision display
    const updateInterval = setInterval(() => {
      const decision = ai.getDecision();
      const stateElem = document.getElementById('ai-state');
      const reasonElem = document.getElementById('ai-reason');
      const targetElem = document.getElementById('ai-target');

      if (stateElem) {
        const stateName = getStateName(decision.state);
        stateElem.textContent = stateName;
      }

      if (reasonElem) {
        reasonElem.textContent = decision.reason;
      }

      if (targetElem) {
        if (decision.targetX !== null && decision.targetY !== null) {
          targetElem.textContent = `(${Math.round(decision.targetX)}, ${Math.round(decision.targetY)})`;
        } else {
          targetElem.textContent = 'None';
        }
      }
    }, 100);

    return () => {
      clearInterval(updateInterval);
      game.destroy(true);
    };
  },
};

function getStateName(state: number): string {
  const names = ['EXPLORE', 'ENGAGE', 'RETREAT', 'COLLECT', 'INTERACT'];
  return names[state] ?? 'UNKNOWN';
}
