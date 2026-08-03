import { describe, expect, it, vi } from 'vitest';
import { createCombatVfx } from '../../src/engine/CombatVfx.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { ftToPx } from '../../src/shared/units.js';

type CombatVfxScene = Parameters<typeof createCombatVfx>[0];

function createSceneStub(): { scene: CombatVfxScene; text: ReturnType<typeof vi.fn> } {
  const textObject = {
    setOrigin: vi.fn(() => textObject),
    setDepth: vi.fn(() => textObject),
    setY: vi.fn(() => textObject),
    setAlpha: vi.fn(() => textObject),
    destroy: vi.fn(),
  };
  const text = vi.fn(() => textObject);
  const scene = {
    add: { text },
    cameras: { getCamera: vi.fn(() => null) },
  };
  return { scene: scene as unknown as CombatVfxScene, text };
}

describe('skill level-up floater rendering', () => {
  it('spawns a floating "+1" text at the emitting position and drains the queue', () => {
    const { scene, text } = createSceneStub();
    const vfx = createCombatVfx(scene);
    const world = createTestWorld();

    world.floaterEvents.push({ kind: 'skillLevelUp', x: 4, y: 6, label: '+1 Swordsmanship' });
    vfx.update(world, 0);

    expect(world.floaterEvents).toHaveLength(0);
    expect(text).toHaveBeenCalledTimes(1);
    const [x, y, label, style] = text.mock.calls[0]!;
    expect(x).toBe(ftToPx(4));
    // Offset higher than a damage number so the two never overlap.
    expect(y).toBe(ftToPx(6) - 22);
    expect(label).toBe('+1 Swordsmanship');
    expect((style as { color: string }).color).toBe('#86efac');

    vfx.destroy();
  });

  it('fades and removes the floater after its lifetime', () => {
    const { scene, text } = createSceneStub();
    const vfx = createCombatVfx(scene);
    const world = createTestWorld();

    world.floaterEvents.push({ kind: 'skillLevelUp', x: 0, y: 0, label: '+1 Swordsmanship' });
    vfx.update(world, 0);
    const textObject = text.mock.results[0]!.value as { setAlpha: ReturnType<typeof vi.fn> };

    vfx.update(world, 300);
    expect(textObject.setAlpha).toHaveBeenCalled();

    vfx.update(world, 5000);
    // Second update after expiry must not touch a destroyed object.
    const alphaCallsAfterExpiry = textObject.setAlpha.mock.calls.length;
    vfx.update(world, 6000);
    expect(textObject.setAlpha.mock.calls.length).toBe(alphaCallsAfterExpiry);

    vfx.destroy();
  });

  it('deterministically staggers same-frame skill floaters so labels do not stack', () => {
    const { scene, text } = createSceneStub();
    const vfx = createCombatVfx(scene);
    const world = createTestWorld();

    world.floaterEvents.push(
      { kind: 'skillLevelUp', x: 4, y: 6, label: '+1 Swordsmanship' },
      { kind: 'skillLevelUp', x: 4, y: 6, label: '+1 Swordsmanship' },
      { kind: 'skillLevelUp', x: 4, y: 6, label: '+1 Swordsmanship' },
    );
    vfx.update(world, 0);

    expect(text).toHaveBeenCalledTimes(3);
    const positions = text.mock.calls.map(([x, y]) => ({ x, y }));
    expect(new Set(positions.map((p) => `${p.x},${p.y}`)).size).toBe(3);
    expect(positions[0]).toEqual({ x: ftToPx(4), y: ftToPx(6) - 22 });
    expect(positions[1]!.y).toBeLessThan(positions[0]!.y);
    expect(positions[2]!.y).toBeLessThan(positions[1]!.y);

    vfx.destroy();
  });

  it('resets stagger indexing per frame cluster instead of counting already-live floaters', () => {
    const { scene, text } = createSceneStub();
    const vfx = createCombatVfx(scene);
    const world = createTestWorld();

    world.floaterEvents.push({ kind: 'skillLevelUp', x: 4, y: 6, label: '+1 Swordsmanship' });
    vfx.update(world, 0);

    world.floaterEvents.push({ kind: 'skillLevelUp', x: 10, y: 12, label: '+1 Dagger' });
    vfx.update(world, 100);

    expect(text).toHaveBeenCalledTimes(2);
    const [, secondY] = text.mock.calls[1]!;
    expect(secondY).toBe(ftToPx(12) - 22);

    vfx.destroy();
  });
});
