import { afterEach, describe, expect, it } from 'vitest';
import {
  PROP_KIND_Z,
  SET_PIECE_TILE_SIZE,
  collectCustomArtRequests,
  findSetPieceNpcByAnchor,
  flattenSetPieceLayers,
  getAllSetPieceDefs,
  getSetPieceDef,
  getSetPieceFootprint,
  getSetPiecePacks,
  getSetPiecesByTheme,
  installDefaultSetPiecePacks,
  installSetPiecePacks,
  isCustomSpriteRef,
  setPiecePackSchema,
} from '../../src/shared/set-piece-types.js';

describe('set piece content packs', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  it('loads the bundled Earth set-piece pack with 10+ set pieces', () => {
    expect(getSetPiecePacks()).toHaveLength(1);
    expect(getAllSetPieceDefs().length).toBeGreaterThanOrEqual(10);
  });

  it('exposes both exact and themed sizing kinds', () => {
    const kinds = new Set(getAllSetPieceDefs().map((def) => def.sizing));
    expect(kinds.has('exact')).toBe(true);
    expect(kinds.has('themed')).toBe(true);
  });

  it("keeps a named exact set piece (Jimmy's Pizza) with a fixed footprint", () => {
    const jimmys = getSetPieceDef('jimmys-pizza');
    expect(jimmys?.sizing).toBe('exact');
    expect(getSetPieceFootprint(jimmys!)).toEqual({ width: 8, height: 6 });
  });

  it('reports the max footprint for themed kits', () => {
    const office = getSetPieceDef('doctors-office');
    expect(office?.sizing).toBe('themed');
    // width/height is the minimum; footprint reflects the max extent.
    expect(office?.width).toBe(6);
    expect(getSetPieceFootprint(office!)).toEqual({ width: 9, height: 7 });
  });

  it('groups set pieces by theme', () => {
    const food = getSetPiecesByTheme('food').map((def) => def.id);
    expect(food).toContain('jimmys-pizza');
    expect(food).toContain('corner-diner');
  });

  it('defaults prop render z from its kind', () => {
    const def = getSetPieceDef('jimmys-pizza')!;
    const actor = def.props.find((p) => p.kind === 'actor');
    const fixture = def.props.find((p) => p.kind === 'fixture');
    expect(actor?.z).toBe(PROP_KIND_Z.actor);
    expect(fixture?.z).toBe(PROP_KIND_Z.fixture);
  });

  it('defaults prop footprint to a single tile', () => {
    const def = getSetPieceDef('jimmys-pizza')!;
    const oven = def.props.find((p) => p.id === 'pizza-oven');
    expect(oven?.width).toBe(1);
    expect(oven?.height).toBe(1);
  });

  it('exercises all three sprite sources across the bundled pack', () => {
    const sources = new Set<string>();
    for (const def of getAllSetPieceDefs()) {
      for (const prop of def.props) {
        for (const layer of prop.layers) {
          sources.add(layer.sprite.source);
        }
      }
    }
    expect(sources).toEqual(new Set(['catalog', 'sheet', 'custom']));
  });

  it('supports layered/stacked composites (flower-pot-on-table pattern)', () => {
    const def = getSetPieceDef('jimmys-pizza')!;
    const composite = def.props.find((p) => p.id === 'booth-table');
    expect(composite!.layers.length).toBeGreaterThan(1);
    // The stacked layer carries an offset so it sits on top of the base sprite.
    expect(composite!.layers[1]?.offsetX).toBeDefined();
  });
});

describe('flattenSetPieceLayers', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  it('orders draw layers by prop z then authored order', () => {
    const def = getSetPieceDef('corporate-cubicles')!;
    const draws = flattenSetPieceLayers(def);
    for (let i = 1; i < draws.length; i++) {
      expect(draws[i]!.z).toBeGreaterThanOrEqual(draws[i - 1]!.z);
    }
  });

  it('emits one draw entry per layer', () => {
    const def = getSetPieceDef('jimmys-pizza')!;
    const layerCount = def.props.reduce((sum, prop) => sum + prop.layers.length, 0);
    expect(flattenSetPieceLayers(def)).toHaveLength(layerCount);
  });
});

describe('collectCustomArtRequests', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  it('collects de-duplicated custom art requests for the whole pack', () => {
    const requests = collectCustomArtRequests(getAllSetPieceDefs());
    const ids = requests.map((req) => req.requestId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('jimmys-neon-sign');
  });

  it('accepts a single set piece', () => {
    const requests = collectCustomArtRequests(getSetPieceDef('jimmys-pizza')!);
    expect(requests.every((req) => isCustomSpriteRef(req))).toBe(true);
    expect(requests.map((req) => req.requestId)).toContain('brick-pizza-oven');
  });
});

describe('setPiecePackSchema', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  it('exposes a tile size constant', () => {
    expect(SET_PIECE_TILE_SIZE).toBe(16);
  });

  it('installs and resets runtime packs (LLM-pack injection path)', () => {
    installSetPiecePacks([
      setPiecePackSchema.parse({
        version: 1,
        packId: 'runtime-test',
        setPieces: [
          {
            id: 'runtime-kiosk',
            name: 'Runtime Kiosk',
            theme: 'retail',
            sizing: 'exact',
            width: 2,
            height: 2,
            description: 'A tiny runtime-injected kiosk.',
            props: [
              {
                id: 'stand',
                kind: 'fixture',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:npc.guide' } }],
              },
            ],
          },
        ],
      }),
    ]);
    expect(getSetPieceDef('runtime-kiosk')).toBeDefined();
    expect(getSetPieceDef('jimmys-pizza')).toBeUndefined();

    installDefaultSetPiecePacks();
    expect(getSetPieceDef('jimmys-pizza')).toBeDefined();
    expect(getSetPieceDef('runtime-kiosk')).toBeUndefined();
  });

  it('rejects props that extend outside the footprint', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'overflow',
            name: 'Overflow',
            theme: 'test',
            sizing: 'exact',
            width: 2,
            height: 2,
            description: 'Prop falls off the edge.',
            props: [
              {
                id: 'wall',
                kind: 'wall',
                x: 3,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/outside/);
  });

  it('rejects maxWidth/maxHeight on exact set pieces', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'bad-exact',
            name: 'Bad Exact',
            theme: 'test',
            sizing: 'exact',
            width: 2,
            height: 2,
            maxWidth: 4,
            description: 'Exact pieces cannot declare a max.',
            props: [
              {
                id: 'p',
                kind: 'floor',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/only valid for themed/);
  });

  it('rejects duplicate prop ids', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'dupes',
            name: 'Dupes',
            theme: 'test',
            sizing: 'exact',
            width: 2,
            height: 2,
            description: 'Two props share an id.',
            props: [
              {
                id: 'p',
                kind: 'floor',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
              {
                id: 'p',
                kind: 'wall',
                x: 1,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/Duplicate prop id/);
  });
});

describe('set piece NPC placement', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  const validNpcPack = {
    version: 1 as const,
    packId: 'npc-test',
    setPieces: [
      {
        id: 'greeting-room',
        name: 'Greeting Room',
        theme: 'welcome',
        sizing: 'exact' as const,
        width: 6,
        height: 5,
        description: 'A room with three placed, spaced NPCs.',
        props: [
          {
            id: 'rug',
            kind: 'floor' as const,
            x: 0,
            y: 0,
            layers: [{ sprite: { source: 'sheet' as const, sheetKey: 'k', col: 0, row: 0 } }],
          },
        ],
        npcs: [
          { id: 'goon', npcTypeId: 'tutorial-goon', x: 3, y: 0, anchorRole: 'welcome' as const },
          { id: 'merchant', npcTypeId: 'shopkeeper', x: 1, y: 4, anchorRole: 'shop' as const },
          {
            id: 'broker',
            npcTypeId: 'spell-quest-giver',
            x: 5,
            y: 4,
            anchorRole: 'spell' as const,
          },
        ],
      },
    ],
  };

  it('defaults npcs to an empty array for prop-only set pieces', () => {
    expect(getSetPieceDef('jimmys-pizza')?.npcs).toEqual([]);
  });

  it('compiles authored NPCs and preserves their tile coordinates', () => {
    installSetPiecePacks([setPiecePackSchema.parse(validNpcPack)]);
    const room = getSetPieceDef('greeting-room')!;
    expect(room.npcs).toHaveLength(3);
    const goon = room.npcs.find((npc) => npc.id === 'goon');
    expect(goon).toMatchObject({ npcTypeId: 'tutorial-goon', x: 3, y: 0, anchorRole: 'welcome' });
  });

  it('resolves NPCs by objective anchor role', () => {
    installSetPiecePacks([setPiecePackSchema.parse(validNpcPack)]);
    const room = getSetPieceDef('greeting-room')!;
    expect(findSetPieceNpcByAnchor(room, 'welcome')?.npcTypeId).toBe('tutorial-goon');
    expect(findSetPieceNpcByAnchor(room, 'shop')?.npcTypeId).toBe('shopkeeper');
    expect(findSetPieceNpcByAnchor(room, 'spell')?.npcTypeId).toBe('spell-quest-giver');
  });

  it('returns undefined for an anchor role no NPC drives', () => {
    // jimmys-pizza is a prop-only set piece in the DEFAULT registry (no npcs),
    // so no anchor role resolves. Use the default registry (do NOT install a
    // replacement pack) so `room` is defined and findSetPieceNpcByAnchor is
    // genuinely called on the miss path rather than short-circuiting on undefined.
    const room = getSetPieceDef('jimmys-pizza')!;
    expect(room.npcs).toHaveLength(0);
    expect(findSetPieceNpcByAnchor(room, 'welcome')).toBeUndefined();
  });

  it('rejects NPCs placed outside the footprint', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'npc-overflow',
            name: 'NPC Overflow',
            theme: 'test',
            sizing: 'exact',
            width: 3,
            height: 3,
            description: 'NPC falls off the edge.',
            props: [
              {
                id: 'p',
                kind: 'floor',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
            npcs: [{ id: 'lost', npcTypeId: 'tutorial-goon', x: 3, y: 0 }],
          },
        ],
      }),
    ).toThrow(/outside/);
  });

  it('rejects duplicate NPC ids', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'npc-dupes',
            name: 'NPC Dupes',
            theme: 'test',
            sizing: 'exact',
            width: 4,
            height: 4,
            description: 'Two NPCs share an id.',
            props: [
              {
                id: 'p',
                kind: 'floor',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
            npcs: [
              { id: 'n', npcTypeId: 'tutorial-goon', x: 0, y: 0 },
              { id: 'n', npcTypeId: 'shopkeeper', x: 1, y: 1 },
            ],
          },
        ],
      }),
    ).toThrow(/Duplicate NPC id/);
  });

  it('rejects unknown npcTypeId references', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'npc-unknown',
            name: 'NPC Unknown',
            theme: 'test',
            sizing: 'exact',
            width: 4,
            height: 4,
            description: 'References an NPC type that does not exist.',
            props: [
              {
                id: 'p',
                kind: 'floor',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
            npcs: [{ id: 'ghost', npcTypeId: 'not-a-real-npc', x: 0, y: 0 }],
          },
        ],
      }),
    ).toThrow(/unknown npcTypeId/);
  });

  it('rejects two NPCs driving the same objective anchor', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'npc-anchor-clash',
            name: 'Anchor Clash',
            theme: 'test',
            sizing: 'exact',
            width: 4,
            height: 4,
            description: 'Two NPCs both claim the welcome anchor.',
            props: [
              {
                id: 'p',
                kind: 'floor',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
            npcs: [
              { id: 'a', npcTypeId: 'tutorial-goon', x: 0, y: 0, anchorRole: 'welcome' },
              { id: 'b', npcTypeId: 'shopkeeper', x: 1, y: 1, anchorRole: 'welcome' },
            ],
          },
        ],
      }),
    ).toThrow(/Duplicate anchorRole/);
  });
});

describe('welcome-room authored set piece', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  const chebyshev = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  it('is a fixed 8x7 reality-show room', () => {
    const room = getSetPieceDef('welcome-room')!;
    expect(room.sizing).toBe('exact');
    expect(getSetPieceFootprint(room)).toEqual({ width: 8, height: 7 });
    expect(room.theme).toBe('reality-show');
  });

  it('places the three floor-1 NPCs on the correct objective anchors', () => {
    const room = getSetPieceDef('welcome-room')!;
    expect(findSetPieceNpcByAnchor(room, 'welcome')?.npcTypeId).toBe('tutorial-goon');
    expect(findSetPieceNpcByAnchor(room, 'shop')?.npcTypeId).toBe('shopkeeper');
    expect(findSetPieceNpcByAnchor(room, 'spell')?.npcTypeId).toBe('spell-quest-giver');
  });

  it('spaces the three NPCs at least 3 tiles apart (Chebyshev)', () => {
    const room = getSetPieceDef('welcome-room')!;
    const goon = findSetPieceNpcByAnchor(room, 'welcome')!;
    const merchant = findSetPieceNpcByAnchor(room, 'shop')!;
    const broker = findSetPieceNpcByAnchor(room, 'spell')!;
    expect(chebyshev(goon, merchant)).toBeGreaterThanOrEqual(3);
    expect(chebyshev(goon, broker)).toBeGreaterThanOrEqual(3);
    expect(chebyshev(merchant, broker)).toBeGreaterThanOrEqual(3);
  });

  it('seats the goon against the back wall with a desk in front and banner behind', () => {
    const room = getSetPieceDef('welcome-room')!;
    const goon = findSetPieceNpcByAnchor(room, 'welcome')!;
    const desk = room.props.find((p) => p.id === 'welcome-desk')!;
    const banner = room.props.find((p) => p.id === 'welcome-banner')!;
    // Back wall is y=0; the goon hugs it.
    expect(goon.y).toBeLessThanOrEqual(1);
    // Desk is in front of the goon (higher row toward the entrance).
    expect(desk.y).toBeGreaterThan(goon.y);
    // Banner is behind the goon (on the back wall) and layers over it.
    expect(banner.y).toBeLessThan(goon.y);
    expect(banner.z).toBeLessThan(desk.z);
  });

  it('gives the merchant a shop table and the broker a bookcase', () => {
    const room = getSetPieceDef('welcome-room')!;
    const merchant = findSetPieceNpcByAnchor(room, 'shop')!;
    const broker = findSetPieceNpcByAnchor(room, 'spell')!;
    const shopTable = room.props.find((p) => p.id === 'shop-table')!;
    const bookcase = room.props.find((p) => p.id === 'broker-bookcase')!;
    // Shop table sits in front of the merchant.
    expect(shopTable.y).toBeGreaterThan(merchant.y);
    expect(Math.abs(shopTable.x - merchant.x)).toBeLessThanOrEqual(2);
    // Bookcase is adjacent to the broker.
    const bookcaseRight = bookcase.x + bookcase.width - 1;
    const nearX = broker.x >= bookcase.x - 1 && broker.x <= bookcaseRight + 1;
    const nearY = Math.abs(broker.y - bookcase.y) <= 1;
    expect(nearX && nearY).toBe(true);
  });

  it('layers a rug over the floor beneath the NPCs and a banner over the wall', () => {
    const room = getSetPieceDef('welcome-room')!;
    const rug = room.props.find((p) => p.id === 'welcome-rug')!;
    const banner = room.props.find((p) => p.id === 'welcome-banner')!;
    // Rug draws first (floor band), banner above terrain but below front furniture.
    expect(rug.z).toBe(PROP_KIND_Z.floor);
    expect(rug.z).toBeLessThan(banner.z);
    // Composite props keep their stacked layers (e.g. wares on the shop table).
    const shopTable = room.props.find((p) => p.id === 'shop-table')!;
    expect(shopTable.layers.length).toBeGreaterThanOrEqual(2);
  });

  it('wires the hero props to their shipped generated catalog art', () => {
    const room = getSetPieceDef('welcome-room')!;
    // Every bespoke welcome-room asset has shipped, so the piece has no
    // outstanding custom art requests left to generate.
    expect(collectCustomArtRequests([room])).toHaveLength(0);
    expect(room.props.some((p) => p.layers.some((l) => isCustomSpriteRef(l.sprite)))).toBe(false);

    // Each hero prop's base layer pins the exact approved generated variant
    // (the velvet rope shipped as var-2, the rest as var-0).
    const baseSpriteId = (propId: string): string => {
      const prop = room.props.find((p) => p.id === propId)!;
      const { sprite } = prop.layers[0]!;
      if (sprite.source !== 'catalog') {
        throw new Error(`${propId} base layer is not a catalog ref`);
      }
      return sprite.spriteId;
    };
    expect(baseSpriteId('welcome-rug')).toBe('welcome-room-rug-var-0');
    expect(baseSpriteId('welcome-desk')).toBe('welcome-room-desk-var-0');
    expect(baseSpriteId('shop-table')).toBe('welcome-room-shop-table-var-0');
    expect(baseSpriteId('broker-bookcase')).toBe('welcome-room-bookcase-var-0');
    expect(baseSpriteId('velvet-rope')).toBe('welcome-room-velvet-rope-var-2');
  });
});
