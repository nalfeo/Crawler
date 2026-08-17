import { describe, expect, it } from 'vitest';
import { createInventoryUI } from '../../src/engine/InventoryUI.js';
import { emptyGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from '../../src/engine/generatedAssets/index.js';
import { createInventoryBag } from '../../src/shared/inventory.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { addGeneratedEquipmentToBag } from '../../src/core/systems/equipmentSystem.js';
import { generatedEquipmentInput } from '../fixtures/generated-equipment.js';
import { generatedEquipmentRunKeyFromSeed } from '../../src/shared/generated-equipment-types.js';

// InventoryUI constants (kept local because they are not exported by the production module).
const INVENTORY_CELL_SIZE = 64;
const TOOLTIP_WIDTH = 200;

interface RectangleStub {
  readonly width: number;
  readonly height: number;
  on(event: string, handler: () => void): RectangleStub;
  emit(event: string): void;
  setInteractive(options?: unknown): RectangleStub;
  setStrokeStyle(width?: number, color?: number): RectangleStub;
  setFillStyle(color?: number): RectangleStub;
  setOrigin(x?: number, y?: number): RectangleStub;
  setScale(x?: number, y?: number): RectangleStub;
  setDepth(depth?: number): RectangleStub;
  setPosition(x?: number, y?: number): RectangleStub;
  setVisible(visible?: boolean): RectangleStub;
  setScrollFactor(x?: number, y?: number): RectangleStub;
  setAlpha(value?: number): RectangleStub;
  setResolution(value?: number): RectangleStub;
  setFontSize(value?: string | number): RectangleStub;
  setColor(value?: string): RectangleStub;
  setText(value?: string): RectangleStub;
  destroy(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
}

interface RenderRecord {
  readonly textStrings: string[];
  readonly tooltipHeights: number[];
  readonly cellRects: RectangleStub[];
}

function makeRectangleStub(
  x: number,
  y: number,
  width: number,
  height: number,
  record: RenderRecord,
): RectangleStub {
  const handlers = new Map<string, () => void>();
  const stub: RectangleStub = {
    width,
    height,
    on(event: string, handler: () => void): RectangleStub {
      handlers.set(event, handler);
      if (
        event === 'pointerover' &&
        width === INVENTORY_CELL_SIZE &&
        height === INVENTORY_CELL_SIZE
      ) {
        record.cellRects.push(stub);
      }
      return stub;
    },
    emit(event: string): void {
      handlers.get(event)?.();
    },
    setInteractive: () => stub,
    setStrokeStyle: () => stub,
    setFillStyle: () => stub,
    setOrigin: () => stub,
    setScale: () => stub,
    setDepth: () => stub,
    setPosition: () => stub,
    setVisible: () => stub,
    setScrollFactor: () => stub,
    setAlpha: () => stub,
    setResolution: () => stub,
    setFontSize: () => stub,
    setColor: () => stub,
    setText: () => stub,
    destroy: () => {},
    getBounds: () => ({ x: x - width / 2, y: y - height / 2, width, height }),
  };
  if (width === TOOLTIP_WIDTH) {
    record.tooltipHeights.push(height);
  }
  return stub;
}

function makeTextStub(record: RenderRecord, text: string): RectangleStub {
  record.textStrings.push(String(text));
  return makeRectangleStub(0, 0, 0, 0, record);
}

function makeContainerStub(): {
  add: (object: unknown) => void;
  addAt: (object: unknown, index: number) => void;
  setScale: (scale?: number) => void;
  setDepth: (depth?: number) => void;
  setVisible: (visible?: boolean) => void;
  destroy: () => void;
} {
  return {
    add: () => {},
    addAt: () => {},
    setScale: () => {},
    setDepth: () => {},
    setVisible: () => {},
    destroy: () => {},
  };
}

function makeScene(record: RenderRecord): unknown {
  const registry = emptyGeneratedSpriteRegistry();
  return {
    cameras: { main: { roundPixels: false } },
    add: {
      container: () => makeContainerStub(),
      rectangle: (x: number, y: number, width: number, height: number) =>
        makeRectangleStub(x, y, width, height, record),
      image: () => makeRectangleStub(0, 0, 0, 0, record),
      text: (_x: number, _y: number, text: string) => makeTextStub(record, text),
    },
    game: {
      registry: {
        get: (key: string) => (key === GENERATED_SPRITE_REGISTRY_KEY ? registry : undefined),
      },
    },
    input: { keyboard: { on: () => {}, off: () => {} } },
    scale: { displaySize: { width: 1280, height: 720 }, on: () => {}, off: () => {} },
    textures: { exists: () => false },
    time: { now: 0 },
  };
}

function seedWorldWithStaticAndGeneratedWeapons() {
  const world = createTestWorld({
    generatedEquipmentRunKey: generatedEquipmentRunKeyFromSeed(42),
  });
  world.inventories.clear();
  const bag = createInventoryBag();
  bag.slots.push({ itemId: 'bone-club', quantity: 1 });
  bag.slots.push({ itemId: 'old-sock', quantity: 1 });
  world.inventories.set(1, bag);

  const generated = createGeneratedEquipmentInstance(
    world,
    generatedEquipmentInput({ baseId: 'plasma-pistol', slots: ['mainHand'], weapon: true }),
  );
  const added = addGeneratedEquipmentToBag(world, 1, generated.instanceId);
  expect(added.ok).toBe(true);
  return { world, generatedInstanceKey: generated.instanceId };
}

describe('InventoryUI weapon tooltip DPS (real render path)', () => {
  it('shows DPS for static/generated weapons and keeps non-weapons at base tooltip height', () => {
    const record: RenderRecord = { textStrings: [], tooltipHeights: [], cellRects: [] };
    const scene = makeScene(record);
    const { world, generatedInstanceKey } = seedWorldWithStaticAndGeneratedWeapons();
    const ui = createInventoryUI(scene as never, { height: 900 });
    ui.toggle(world);

    const staticWeaponIndex = ui.getCellIndexForItem('bone-club');
    const nonWeaponIndex = ui.getCellIndexForItem('old-sock');
    const generatedWeaponIndex = ui.getCellIndexForEntry({
      kind: 'generated-instance',
      instanceKey: generatedInstanceKey,
    });

    expect(staticWeaponIndex).not.toBeNull();
    expect(generatedWeaponIndex).not.toBeNull();
    expect(nonWeaponIndex).not.toBeNull();
    if (staticWeaponIndex === null || generatedWeaponIndex === null || nonWeaponIndex === null)
      return;

    const hover = (index: number) => {
      const rect = record.cellRects[index];
      expect(rect).toBeDefined();
      if (!rect) return { lines: [] as string[], lastTooltipHeight: 0 };
      const textStart = record.textStrings.length;
      const tooltipStart = record.tooltipHeights.length;
      rect.emit('pointerover');
      return {
        lines: record.textStrings.slice(textStart),
        lastTooltipHeight: record.tooltipHeights[tooltipStart] ?? 0,
      };
    };

    const staticWeaponTooltip = hover(staticWeaponIndex);
    expect(staticWeaponTooltip.lines.some((line) => line.startsWith('DPS: '))).toBe(true);
    expect(staticWeaponTooltip.lastTooltipHeight).toBe(128);

    const generatedWeaponTooltip = hover(generatedWeaponIndex);
    expect(generatedWeaponTooltip.lines.some((line) => line.startsWith('DPS: '))).toBe(true);
    expect(generatedWeaponTooltip.lastTooltipHeight).toBe(128);

    const nonWeaponTooltip = hover(nonWeaponIndex);
    expect(nonWeaponTooltip.lines.some((line) => line.startsWith('DPS: '))).toBe(false);
    expect(nonWeaponTooltip.lastTooltipHeight).toBe(110);
  });
});
