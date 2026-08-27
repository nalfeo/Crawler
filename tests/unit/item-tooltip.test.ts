import { describe, expect, it } from 'vitest';
import { getEquipmentTooltipCardLayout, renderItemTooltip } from '../../src/engine/item-tooltip.js';
import { ItemRarity, type ItemDef } from '../../src/shared/items.js';

interface StubObject {
  text?: string;
  strokeColor?: number;
  style?: Phaser.Types.GameObjects.Text.TextStyle;
  width: number;
  height: number;
  x: number;
  y: number;
  setOrigin: () => StubObject;
  setScale: () => StubObject;
  setStrokeStyle: (width?: number, color?: number) => StubObject;
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
    setStrokeStyle: (_width?: number, color?: number) => {
      value.strokeColor = color;
      return value;
    },
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
      text: (
        x: number,
        y: number,
        text: string,
        style?: Phaser.Types.GameObjects.Text.TextStyle,
      ) => {
        const result = object(x, y, text.length * 6, 14, text);
        result.style = style;
        return result;
      },
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
  it('content-sizes equipped cards and keeps stats clear of the icon', () => {
    const layout = getEquipmentTooltipCardLayout(176, ['+2 Armor', '+1 Strength'], def.description);
    const iconBottom = layout.icon.y + layout.icon.size / 2;

    expect(layout.headerCenterY).toBe(12);
    expect(layout.statStartY).toBeGreaterThan(iconBottom);
    expect(layout.descriptionY - (layout.statStartY + 18 + 14)).toBe(12);
    expect(layout.height).toBe(layout.descriptionY + 2 * 14 + 10);
  });

  it('reserves separate measured space for candidate differences', () => {
    const layout = getEquipmentTooltipCardLayout(176, ['+2 Armor'], def.description, [
      'No stat change',
    ]);

    expect(layout.diffStartY).toBeGreaterThanOrEqual(
      layout.descriptionY + layout.descriptionHeight,
    );
    expect(layout.height).toBeGreaterThan(layout.diffStartY);
  });

  it('sizes flavor space from word wrapping rather than raw character count', () => {
    const layout = getEquipmentTooltipCardLayout(
      176,
      ['+2 Armor', '+1 Constitution'],
      'A dented pot with eyeholes. Surprisingly reassuring.',
    );

    expect(layout.descriptionHeight).toBe(42);
    expect(layout.height).toBe(layout.descriptionY + layout.descriptionHeight + 10);
  });

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
      statLines: [
        {
          text: '+1 Charisma',
          deltaText: ' (+1)',
          deltaColor: '#49d06f',
        },
      ],
      flavorText: def.description,
      diffLines: ['Charisma +1', 'Armor -2'],
      placement: { x: 24, y: 36, width: 220, height: 136 },
      crispText: (x, y, text, style) =>
        (
          scene as {
            add: {
              text: (
                x: number,
                y: number,
                text: string,
                style?: Phaser.Types.GameObjects.Text.TextStyle,
              ) => StubObject;
            };
          }
        ).add.text(x, y, text, style) as never,
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
    expect(background.strokeColor).toBe(0xe9c46a);
    const title = objects.find((entry) => entry.text === "Merchant's Charm");
    const stat = objects.find((entry) => entry.text === '+1 Charisma');
    const delta = objects.find((entry) => entry.text === ' (+1)');
    expect(title?.x).toBe(32);
    expect(stat?.x).toBe(32);
    expect(delta?.x).toBe(98);
    expect(delta?.style).toMatchObject({ color: '#49d06f', fontStyle: 'bold' });
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
