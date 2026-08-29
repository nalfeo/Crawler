/**
 * Status-effect aura renderer (`src/engine/StatusEffectVfx.ts`).
 *
 * Exercises the shared-Graphics contract: one object for every aura, cleared and
 * redrawn each frame, hidden when nothing is affected, and destroyed on teardown.
 */
import { describe, expect, it } from 'vitest';
import { createStatusEffectVfx } from '../../src/engine/StatusEffectVfx.js';
import { WORLD_VFX_DEPTH } from '../../src/shared/render-depths.js';
import { createSceneStub, MockGraphics } from '../fixtures/phaser-bridge-harness.js';

const TARGET = { x: 100, y: 50, radiusPx: 12, color: 0x7dd3fc };

describe('createStatusEffectVfx', () => {
  it('draws every aura into ONE shared Graphics on the ground plane', () => {
    const stub = createSceneStub({ withGraphics: true });
    const vfx = createStatusEffectVfx(stub.scene);

    vfx.update([TARGET, { ...TARGET, x: 200 }, { ...TARGET, x: 300 }], 0);

    expect(stub.graphics).toHaveLength(1);
    const gfx = stub.graphics[0] as MockGraphics;
    expect(gfx.depth).toBe(WORLD_VFX_DEPTH.statusAura);
    expect(gfx.depth).toBeLessThan(0);
    expect(gfx.fillEllipses).toHaveLength(3);
    expect(gfx.strokeEllipses).toHaveLength(3);
    expect(gfx.fillCalls.every((call) => call.color === TARGET.color)).toBe(true);
  });

  it('redraws rather than accumulating across frames', () => {
    const stub = createSceneStub({ withGraphics: true });
    const vfx = createStatusEffectVfx(stub.scene);

    vfx.update([TARGET], 0);
    vfx.update([TARGET], 300);

    expect(stub.graphics).toHaveLength(1);
    expect((stub.graphics[0] as MockGraphics).fillEllipses).toHaveLength(1);
  });

  it('pulses deterministically from the render clock', () => {
    const stub = createSceneStub({ withGraphics: true });
    const vfx = createStatusEffectVfx(stub.scene);
    const gfx = (): MockGraphics => stub.graphics[0] as MockGraphics;

    vfx.update([TARGET], 0);
    const trough = gfx().fillCalls[0]!.alpha;
    vfx.update([TARGET], 450);
    const peak = gfx().fillCalls[0]!.alpha;
    vfx.update([TARGET], 900);
    const wrapped = gfx().fillCalls[0]!.alpha;

    expect(peak).toBeGreaterThan(trough);
    expect(wrapped).toBeCloseTo(trough, 6);
  });

  it('hides the layer when nothing is affected', () => {
    const stub = createSceneStub({ withGraphics: true });
    const vfx = createStatusEffectVfx(stub.scene);

    vfx.update([TARGET], 0);
    vfx.update([], 16);

    const gfx = stub.graphics[0] as MockGraphics;
    expect(gfx.visible).toBe(false);
    expect(gfx.fillEllipses).toHaveLength(0);
  });

  it('creates nothing before the first affected entity, and destroys cleanly', () => {
    const stub = createSceneStub({ withGraphics: true });
    const vfx = createStatusEffectVfx(stub.scene);

    vfx.update([], 0);
    expect(stub.graphics).toHaveLength(0);

    vfx.update([TARGET], 16);
    vfx.destroy();
    expect((stub.graphics[0] as MockGraphics).destroyed).toBe(true);
  });

  it('no-ops on a scene without a graphics factory', () => {
    const stub = createSceneStub();
    const vfx = createStatusEffectVfx(stub.scene);

    expect(() => {
      vfx.update([TARGET], 0);
      vfx.destroy();
    }).not.toThrow();
    expect(stub.graphics).toHaveLength(0);
  });
});
