import { describe, it, expect, vi } from 'vitest';
import {
  createEffectsVfx,
  PLAYER_HURT_PULSE_COLOR,
  PLAYER_HURT_PULSE_DURATION_MS,
  PLAYER_HURT_SHAKE_DURATION_MS,
  PLAYER_HURT_SHAKE_INTENSITY,
} from '../../src/engine/EffectsVfx.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { CombatEvent } from '../../src/shared/combat-events.js';

type EffectsScene = Parameters<typeof createEffectsVfx>[0];

/** Minimal Phaser scene mock that satisfies the EffectsVfx capability guard and
 *  exposes VFX/camera spies so player-hurt feedback can be observed. */
function createMockScene() {
  const flash = vi.fn();
  const shake = vi.fn();
  const shape = { setDepth: vi.fn(), setBlendMode: vi.fn(), destroy: vi.fn() };
  const addCircle = vi.fn(() => shape);
  const scene = {
    add: {
      circle: addCircle,
      rectangle: vi.fn(() => shape),
    },
    tweens: { add: vi.fn(), killTweensOf: vi.fn() },
    cameras: {
      main: { flash, shake },
      getCamera: vi.fn(() => null),
    },
  };
  return {
    scene: scene as unknown as EffectsScene,
    flash,
    shake,
    addCircle,
    addTween: scene.tweens.add,
  };
}

function playerHit(): CombatEvent {
  return { type: 'hit', x: 0, y: 0, amount: 5, targetType: 'player', timestamp: 0 };
}

describe('EffectsVfx player-hurt throttle', () => {
  it('does not poison the throttle when a playerHurt VfxEvent is queued', () => {
    const { scene, flash, shake, addCircle } = createMockScene();
    const vfx = createEffectsVfx(scene);
    const world = createTestWorld();

    // A queue-sourced player-hurt fires at t=1000ms.
    world.vfxEvents.push({ kind: 'playerHurt', x: 0, y: 0 });
    vfx.update(world, 1000);
    expect(flash).not.toHaveBeenCalled();
    expect(shake).toHaveBeenCalledTimes(1);
    expect(addCircle).toHaveBeenCalledTimes(1);

    // A later combat-sourced player hit, well past the throttle window, must
    // still fire. The old code stamped lastPlayerHurtMs with +Infinity here,
    // which made every subsequent finite-timestamp hit evaluate to -Infinity and
    // silenced player-hurt feedback permanently.
    world.combatEvents.push(playerHit());
    vfx.update(world, 5000);
    expect(flash).not.toHaveBeenCalled();
    expect(shake).toHaveBeenCalledTimes(2);
    expect(addCircle).toHaveBeenCalledTimes(2);
  });

  it('still throttles rapid combat-sourced player hits within the window', () => {
    const { scene, shake } = createMockScene();
    const vfx = createEffectsVfx(scene);
    const world = createTestWorld();
    world.combatEvents.push(playerHit());

    vfx.update(world, 1000);
    expect(shake).toHaveBeenCalledTimes(1);

    // Within PLAYER_HURT_THROTTLE_MS (120ms) → suppressed.
    vfx.update(world, 1050);
    expect(shake).toHaveBeenCalledTimes(1);

    // Past the window → fires again.
    vfx.update(world, 1200);
    expect(shake).toHaveBeenCalledTimes(2);
  });

  it('fires the first player-hurt immediately from render time zero', () => {
    const { scene, shake } = createMockScene();
    const vfx = createEffectsVfx(scene);
    const world = createTestWorld();
    world.combatEvents.push(playerHit());

    vfx.update(world, 0);
    expect(shake).toHaveBeenCalledTimes(1);
  });

  it('uses a localized pulse and soft shake instead of a full-screen camera flash', () => {
    const { scene, flash, shake, addCircle, addTween } = createMockScene();
    const vfx = createEffectsVfx(scene);
    const world = createTestWorld();
    world.combatEvents.push(playerHit());

    vfx.update(world, 0);

    expect(flash).not.toHaveBeenCalled();
    expect(shake).toHaveBeenCalledWith(PLAYER_HURT_SHAKE_DURATION_MS, PLAYER_HURT_SHAKE_INTENSITY);
    expect(addCircle).toHaveBeenCalledWith(0, 0, 10, PLAYER_HURT_PULSE_COLOR, 0.32);
    expect(addTween).toHaveBeenCalledWith(
      expect.objectContaining({
        duration: PLAYER_HURT_PULSE_DURATION_MS,
        ease: 'Cubic.easeOut',
      }),
    );
  });
});
