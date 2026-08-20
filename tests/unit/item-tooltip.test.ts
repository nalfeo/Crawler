import { describe, expect, it } from 'vitest';
import { renderItemTooltip } from '../../src/engine/item-tooltip.js';
import { ItemRarity, type ItemDef } from '../../src/shared/items.js';

interface StubObject {
  text?: string;
  width: number;
  height: number;
  x: number;
  y: number;
  setOrigin: () => StubObject;
  setScale: () => StubObject;
  setStrokeStyle: () => StubObject;
  getBounds: () => { x: number; y: number; width: number; height: number };
}

function object(x: number, y: number, width: number, height: number, text?: string): StubObject {
  const value: StubObject = {
    text,
    width,
    height,
    x,
    y,
    setOrigin: () => value,
    setScale: () => value,
    setStrokeStyle: () => value,
    getBounds: () => ({ x: x - width / 2, y: y - height / 2, width, height }),
  };
  return value;
}

function makeScene(): unknown {
  return {
    add: {
      rectangle: (x: number, y: number, width: number, height: number) =>
        object(x, y, width, height),
      image: (x: number, y: number) => object(x, y, 32, 32),
      text: (x: number, y: number, text: string) => object(x, y, text.length * 6, 14, text),
    },
    textures: { exists: (key: string) => key === 'charm-icon' },
    game: { registry: { get: () => undefined } },
  };
}

function makeContainer(objects: StubObject[]): unknown {
  return { add: (value: StubObject) => objects.push(value) };
}

const def: ItemDef = {
  id: 'merchant-charm',
  name: "Merchant's Charm",
  description: 'Warm metal, colder bargain.',
  tags: ['gear'] as ItemDef['tags'],
  rarity: ItemRarity.Uncommon,
  maxStack: 1,
};

describe('item tooltip redesign', () => {
  it('renders icon, stats, flavor, and candidate differences inside the requested card', () => {
    const objects: StubObject[] = [];
    const scene = makeScene();
    const tooltipObjects = renderItemTooltip({
      scene: scene as never,
      container: makeContainer(objects) as never,
      panelX: 0,
      panelY: 0,
      panelWidth: 640,
      panelHeight: 360,
      anchorX: 0,
      anchorY: 0,
      anchorSize: 0,
      def,
      quantity: 1,
      fontFamily: 'Arial',
      sectionLabel: 'CANDIDATE',
      iconTextureKey: 'charm-icon',
      statLines: ['+1 Charisma'],
      flavorText: def.description,
      diffLines: ['Charisma +1', 'Armor -2'],
      placement: { x: 24, y: 36, width: 220, height: 136 },
      crispText: (x, y, text) =>
        (scene as { add: { text: (x: number, y: number, text: string) => StubObject } }).add.text(
          x,
          y,
          text,
        ) as never,
    });

    const text = objects.flatMap((entry) => (entry.text ? [entry.text] : []));
    expect(text).toEqual(
      expect.arrayContaining([
        'CANDIDATE',
        "Merchant's Charm",
        '+1 Charisma',
        'Warm metal, colder bargain.',
        'Charisma +1',
        'Armor -2',
      ]),
    );
    const background = tooltipObjects[0] as unknown as StubObject;
    expect(background.getBounds()).toMatchObject({ x: 24, y: 36, width: 220, height: 136 });
  });

  it('keeps current and candidate cards in separate, stable placements', () => {
    const placements = [
      { x: 18, y: 40, width: 180, height: 136 },
      { x: 206, y: 40, width: 180, height: 136 },
    ];
    const bounds = placements.map((placement) => {
      const objects: StubObject[] = [];
      const scene = makeScene();
      const rendered = renderItemTooltip({
        scene: scene as never,
        container: makeContainer(objects) as never,
        panelX: 0,
        panelY: 0,
        panelWidth: 640,
        panelHeight: 360,
        anchorX: 0,
        anchorY: 0,
        anchorSize: 0,
        def,
        quantity: 1,
        fontFamily: 'Arial',
        sectionLabel: 'CURRENT',
        placement,
        crispText: (x, y, text) =>
          (scene as { add: { text: (x: number, y: number, text: string) => StubObject } }).add.text(
            x,
            y,
            text,
          ) as never,
      });
      return (rendered[0] as unknown as StubObject).getBounds();
    });

    expect(bounds[0]).toMatchObject({ x: 18, y: 40, width: 180, height: 136 });
    expect(bounds[1]).toMatchObject({ x: 206, y: 40, width: 180, height: 136 });
    expect(bounds[0]!.x + bounds[0]!.width).toBeLessThanOrEqual(bounds[1]!.x);
  });
});
