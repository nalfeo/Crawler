import { describe, expect, it, vi } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { setActiveWeaponDef } from '../../src/core/active-weapon.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createEmptyAbilityState } from '../../src/shared/abilities.js';
import { createTestWorld } from '../helpers/world-factory.js';

type RectState = {
  visible: boolean;
  fillColor: number;
  fillAlpha: number;
  strokeColor: number | null;
  strokeWidth: number | null;
};

function createRectangle(fillColor = 0, fillAlpha = 1) {
  const state: RectState = {
    visible: true,
    fillColor,
    fillAlpha,
    strokeColor: null,
    strokeWidth: null,
  };
  return Object.assign(state, {
    setStrokeStyle(width: number, color: number) {
      state.strokeWidth = width;
      state.strokeColor = color;
      return this;
    },
    setFillStyle(color: number, alpha = 1) {
      state.fillColor = color;
      state.fillAlpha = alpha;
      return this;
    },
    setOrigin: vi.fn().mockReturnThis(),
    setScrollFactor: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    setVisible(visible: boolean) {
      state.visible = visible;
      return this;
    },
    setSize: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  });
}

function createText() {
  return {
    visible: true,
    setScrollFactor: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    setOrigin: vi.fn().mockReturnThis(),
    setVisible(visible: boolean) {
      this.visible = visible;
      return this;
    },
    setColor: vi.fn().mockReturnThis(),
    setText: vi.fn().mockReturnThis(),
    setFontSize: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
}

function createImage() {
  return {
    visible: true,
    width: 16,
    height: 16,
    setScrollFactor: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    setVisible(visible: boolean) {
      this.visible = visible;
      return this;
    },
    setTexture: vi.fn().mockReturnThis(),
    setScale: vi.fn().mockReturnThis(),
    setAlpha: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
}

vi.mock('../../src/engine/pixel-ui.js', () => ({
  createBeveledPanel: vi.fn(() => createRectangle()),
}));

vi.mock('../../src/engine/ui-scale.js', () => ({
  applyCrispText: vi.fn(() => () => {}),
  fitScaleForBox: vi.fn(() => 1),
}));

vi.mock('../../src/engine/ability-icon.js', () => ({
  getAbilityIconEntry: vi.fn(() => null),
}));

function createSceneStub() {
  const rectangles: ReturnType<typeof createRectangle>[] = [];
  const scene = {
    add: {
      rectangle: vi.fn((_x, _y, _width, _height, fillColor = 0, fillAlpha = 1) => {
        const rectangle = createRectangle(fillColor, fillAlpha);
        rectangles.push(rectangle);
        return rectangle;
      }),
      text: vi.fn(() => createText()),
      image: vi.fn(() => createImage()),
    },
  };
  return {
    scene: scene as unknown as Parameters<
      typeof import('../../src/engine/HudAbilityBar.js').createHudAbilityBar
    >[0],
    rectangles,
  };
}

function worldWithArcaneNova(weaponId: string) {
  const world = createTestWorld({ seed: 42 });
  const player = spawnPlayer(world, 0, 0);
  const state = createEmptyAbilityState();
  state.equippedActiveAbilityIds = ['arcane-nova'];
  state.cooldownFramesByAbilityId.set('arcane-nova', 600);
  world.abilityStatesByEntity.set(player, state);
  world.featureUnlocks.spells = false;
  setActiveWeaponDef(world, getWeaponDef(weaponId)!);
  return { world, player };
}

describe('HudAbilityBar — pre-spellbook active prerequisites', () => {
  it('shows pre-spellbook actives and renders unmet weapon prerequisites as locked', async () => {
    const { createHudAbilityBar } = await import('../../src/engine/HudAbilityBar.js');
    const { scene, rectangles } = createSceneStub();
    const bar = createHudAbilityBar(scene);
    const { world, player } = worldWithArcaneNova('sword');

    bar.sync(world, player);

    expect(rectangles[0]?.visible).toBe(true);
    expect(rectangles[0]?.fillColor).toBe(0x1b2136);
    expect(rectangles[0]?.strokeColor).toBe(0x5c4a2a);
  });

  it('renders a weapon-gated active as usable when the current weapon matches', async () => {
    const { createHudAbilityBar } = await import('../../src/engine/HudAbilityBar.js');
    const { scene, rectangles } = createSceneStub();
    const bar = createHudAbilityBar(scene);
    const { world, player } = worldWithArcaneNova('fireball');

    bar.sync(world, player);

    expect(rectangles[0]?.visible).toBe(true);
    expect(rectangles[0]?.fillColor).toBe(0x2d456f);
    expect(rectangles[0]?.strokeColor).toBe(0x8fa9cf);
  });
});
