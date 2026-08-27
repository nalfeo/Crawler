import { describe, expect, it } from 'vitest';
import { createInventoryUI } from '../../src/engine/InventoryUI.js';
import { emptyGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from '../../src/engine/generatedAssets/index.js';
import { createInventoryBag } from '../../src/shared/inventory.js';
import { getItemById } from '../../src/shared/items.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { addGeneratedEquipmentToBag } from '../../src/core/systems/equipmentSystem.js';
import { generatedEquipmentInput } from '../fixtures/generated-equipment.js';
import { generatedEquipmentRunKeyFromSeed } from '../../src/shared/generated-equipment-types.js';

// InventoryUI constants (kept local because they are not exported by the production module).
const INVENTORY_CELL_SIZE = 64;
const TOOLTIP_WIDTH = 200;
const TOOLTIP_CONTENT_WIDTH = TOOLTIP_WIDTH - 16;

interface TextRecord {
  readonly text: string;
  readonly style: Phaser.Types.GameObjects.Text.TextStyle | undefined;
  readonly getBounds: () => { x: number; y: number; width: number; height: number };
}

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
  readonly textRecords: TextRecord[];
  readonly tooltipHeights: number[];
  readonly tooltipBounds: Array<{ x: number; y: number; width: number; height: number }>;
  readonly cellRects: RectangleStub[];
}

function makeRectangleStub(
  x: number,
  y: number,
  width: number,
  height: number,
  record: RenderRecord,
  boundsOrigin: 'center' | 'topLeft' = 'center',
): RectangleStub {
  const handlers = new Map<string, () => void>();
  let currentX = x;
  let currentY = y;
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
    setPosition: (nextX?: number, nextY?: number) => {
      currentX = nextX ?? currentX;
      currentY = nextY ?? currentY;
      return stub;
    },
    setVisible: () => stub,
    setScrollFactor: () => stub,
    setAlpha: () => stub,
    setResolution: () => stub,
    setFontSize: () => stub,
    setColor: () => stub,
    setText: () => stub,
    destroy: () => {},
    getBounds: () => ({
      x: boundsOrigin === 'center' ? currentX - width / 2 : currentX,
      y: boundsOrigin === 'center' ? currentY - height / 2 : currentY,
      width,
      height,
    }),
  };
  if (width === TOOLTIP_WIDTH) {
    record.tooltipHeights.push(height);
    record.tooltipBounds.push(stub.getBounds());
  }
  return stub;
}

function makeTextStub(
  record: RenderRecord,
  text: string,
  style?: Phaser.Types.GameObjects.Text.TextStyle,
): RectangleStub {
  record.textStrings.push(String(text));
  const wrapWidth = style?.wordWrap?.width;
  const fontSize =
    typeof style?.fontSize === 'string' ? Number.parseInt(style.fontSize, 10) : style?.fontSize;
  const glyphWidth = (Number.isFinite(fontSize) ? Number(fontSize) : 11) * 0.7;
  const width =
    typeof wrapWidth === 'number'
      ? Math.min(wrapWidth, Math.ceil(String(text).length * glyphWidth))
      : Math.ceil(String(text).length * glyphWidth);
  const visualLines =
    typeof wrapWidth === 'number' && wrapWidth > 0
      ? Math.max(1, Math.ceil((String(text).length * glyphWidth) / wrapWidth))
      : 1;
  const height = visualLines * 18;
  const stub = makeRectangleStub(0, 0, width, height, record, 'topLeft');
  record.textRecords.push({ text: String(text), style, getBounds: stub.getBounds });
  return stub;
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
      text: (
        _x: number,
        _y: number,
        text: string,
        style?: Phaser.Types.GameObjects.Text.TextStyle,
      ) => makeTextStub(record, text, style),
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

function seedWorldWithStaticAndGeneratedWeapons(options?: { readonly baseId?: string }) {
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
    generatedEquipmentInput({
      baseId: options?.baseId ?? 'plasma-pistol',
      slots: ['mainHand'],
      weapon: true,
    }),
  );
  const added = addGeneratedEquipmentToBag(world, 1, generated.instanceId);
  expect(added.ok).toBe(true);
  return { world, generatedInstanceKey: generated.instanceId };
}

describe('InventoryUI weapon tooltip DPS (real render path)', () => {
  it('shows DPS for static/generated weapons and keeps non-weapons at base tooltip height', () => {
    const record: RenderRecord = {
      textStrings: [],
      textRecords: [],
      tooltipHeights: [],
      tooltipBounds: [],
      cellRects: [],
    };
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
      if (!rect) {
        return {
          lines: [] as string[],
          records: [] as TextRecord[],
          lastTooltipHeight: 0,
          lastTooltipBounds: undefined,
        };
      }
      const textStart = record.textStrings.length;
      const textRecordStart = record.textRecords.length;
      const tooltipStart = record.tooltipHeights.length;
      rect.emit('pointerover');
      return {
        lines: record.textStrings.slice(textStart),
        records: record.textRecords.slice(textRecordStart),
        lastTooltipHeight: record.tooltipHeights[tooltipStart] ?? 0,
        lastTooltipBounds: record.tooltipBounds[tooltipStart],
      };
    };

    const staticWeaponTooltip = hover(staticWeaponIndex);
    expect(staticWeaponTooltip.lines.some((line) => line.startsWith('DPS: '))).toBe(true);
    expect(staticWeaponTooltip.lastTooltipHeight).toBe(128);

    const generatedWeaponTooltip = hover(generatedWeaponIndex);
    expect(generatedWeaponTooltip.lines.some((line) => line.startsWith('DPS: '))).toBe(true);
    expect(generatedWeaponTooltip.lines).toEqual(
      expect.arrayContaining([
        getItemById('plasma-pistol')?.description,
        'Main Hand',
        '+3 ARMOR',
        '4 lb',
      ]),
    );
    expect(generatedWeaponTooltip.lastTooltipHeight).toBe(182);
    const generatedStatRecords = generatedWeaponTooltip.records.filter(
      (record) =>
        record.text.startsWith('DPS: ') ||
        record.text === 'Main Hand' ||
        record.text === '+3 ARMOR' ||
        record.text === '4 lb',
    );
    expect(generatedStatRecords).toHaveLength(4);
    expect(generatedWeaponTooltip.lastTooltipBounds).toBeDefined();
    const tooltipBounds = generatedWeaponTooltip.lastTooltipBounds;
    if (!tooltipBounds) return;
    for (const statRecord of generatedStatRecords) {
      expect(statRecord.style?.wordWrap).toEqual({ width: TOOLTIP_CONTENT_WIDTH });
      const bounds = statRecord.getBounds();
      expect(bounds.x).toBeGreaterThanOrEqual(tooltipBounds.x + 8);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        tooltipBounds.x + 8 + TOOLTIP_CONTENT_WIDTH,
      );
    }

    const nonWeaponTooltip = hover(nonWeaponIndex);
    expect(nonWeaponTooltip.lines.some((line) => line.startsWith('DPS: '))).toBe(false);
    expect(nonWeaponTooltip.lastTooltipHeight).toBe(110);
  });

  it('uses neutral flavor fallback for generated-only bases in the tooltip render path', () => {
    const record: RenderRecord = {
      textStrings: [],
      textRecords: [],
      tooltipHeights: [],
      tooltipBounds: [],
      cellRects: [],
    };
    const scene = makeScene(record);
    const { world, generatedInstanceKey } = seedWorldWithStaticAndGeneratedWeapons({
      baseId: 'equipment/weapon/bone-saw',
    });
    const ui = createInventoryUI(scene as never, { height: 900 });
    ui.toggle(world);

    const generatedWeaponIndex = ui.getCellIndexForEntry({
      kind: 'generated-instance',
      instanceKey: generatedInstanceKey,
    });

    expect(generatedWeaponIndex).not.toBeNull();
    if (generatedWeaponIndex === null) return;
    const rect = record.cellRects[generatedWeaponIndex];
    expect(rect).toBeDefined();
    rect?.emit('pointerover');

    expect(record.textStrings).toContain(
      'A dungeon-forged reward with terms the producers refuse to print.',
    );
    expect(record.textStrings).not.toContain('equipment/weapon/bone-saw');
  });
});
