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
  resolveSetPieceDoorSlots,
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
    expect(getSetPieceFootprint(jimmys!)).toEqual({ width: 10, height: 8 });
  });

  it('reports the max footprint for themed kits', () => {
    const office = getSetPieceDef('doctors-office');
    expect(office?.sizing).toBe('themed');
    // width/height is the minimum; footprint reflects the max extent.
    expect(office?.width).toBe(8);
    expect(getSetPieceFootprint(office!)).toEqual({ width: 11, height: 9 });
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

  it('treats explicit sceneLayers field as authoritative even when empty', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad-scene-layer-ref',
        setPieces: [
          {
            id: 'layered',
            name: 'Layered',
            theme: 'test',
            sizing: 'exact',
            width: 2,
            height: 2,
            description: 'Explicit empty layer list should still validate sceneLayer refs.',
            sceneLayers: [],
            props: [
              {
                id: 'p',
                kind: 'fixture',
                x: 0,
                y: 0,
                sceneLayer: 'ghost',
                layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:npc.guide' } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/references unknown sceneLayer/);
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

  it('compiles NPC visual override, size, and transform metadata', () => {
    const pack = JSON.parse(JSON.stringify(validNpcPack)) as typeof validNpcPack;
    const goon = pack.setPieces[0]!.npcs[0] as Record<string, unknown>;
    goon.widthFt = 5;
    goon.heightFt = 7;
    goon.flipX = true;
    goon.flipY = true;
    goon.rotationDeg = 180;
    goon.spriteOverride = { source: 'catalog', spriteId: 'sprite:npc.guide' };

    installSetPiecePacks([setPiecePackSchema.parse(pack)]);
    const room = getSetPieceDef('greeting-room')!;
    const compiled = room.npcs.find((npc) => npc.id === 'goon');
    expect(compiled).toMatchObject({
      widthFt: 5,
      heightFt: 7,
      flipX: true,
      flipY: true,
      rotationDeg: 180,
      spriteOverride: { source: 'catalog', spriteId: 'sprite:npc.guide' },
    });
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

  it('rejects NPC widthFt/heightFt when only one side is provided', () => {
    const pack = JSON.parse(JSON.stringify(validNpcPack)) as typeof validNpcPack;
    const goon = pack.setPieces[0]!.npcs[0] as Record<string, unknown>;
    goon.widthFt = 5;
    delete goon.heightFt;
    expect(() => setPiecePackSchema.parse(pack)).toThrow(
      /must specify widthFt and heightFt together/,
    );
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

  it('is a fixed 7x7 reality-show room', () => {
    const room = getSetPieceDef('welcome-room')!;
    expect(room.sizing).toBe('exact');
    expect(getSetPieceFootprint(room)).toEqual({ width: 7, height: 7 });
    expect(room.theme).toBe('reality-show');
  });

  it('places the three floor-1 NPCs on the correct objective anchors', () => {
    const room = getSetPieceDef('welcome-room')!;
    expect(findSetPieceNpcByAnchor(room, 'welcome')?.npcTypeId).toBe('tutorial-goon');
    expect(findSetPieceNpcByAnchor(room, 'shop')?.npcTypeId).toBe('shopkeeper');
    expect(findSetPieceNpcByAnchor(room, 'spell')?.npcTypeId).toBe('spell-quest-giver');
  });

  /**
   * A tile is 4 ft, so 3 tiles is 12 ft — deliberately wider than
   * `NPC_INTERACT_RANGE_FT` (10 ft). `npcSystem` sets `nearbyPlayer`
   * independently per NPC with no nearest-NPC arbitration, so two NPCs closer
   * than the interact range would both light up at once and the player could
   * not tell which one they are about to talk to.
   *
   * This is also what forces the room to be at least 7x7: an NPC is 6.6 ft =
   * 1.65 tiles and `stampSetPiece` requires its whole footprint inside the
   * interior, leaving a usable span of `size - 3.65` per axis. Three points
   * pairwise 3 apart need >= 3 of span on BOTH axes, so both sides need
   * >= 6.65 tiles. Do not shrink the room to make a dressing pass fit.
   */
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
    // Back wall is y=0; one perimeter wall tile means the playable back row is y=1.
    expect(goon.y).toBeLessThanOrEqual(2);
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
    // Every prop's art has now been generated, approved and wired, so the room
    // has no outstanding custom art-request left: it must render entirely as
    // real art, never as labeled pending-art boxes. Props must also never fall
    // back to arbitrary Kenney tile frames masquerading as furniture, nor to a
    // plausible-but-wrong catalog reuse.
    const requestIds = collectCustomArtRequests([room])
      .map((req) => req.requestId)
      .sort();
    expect(requestIds).toEqual([]);
    // The formerly-queued decor props now resolve to their own bespoke,
    // approved generated art — keyed by the bare request id they were briefed
    // under, which is what keeps generated art from orphaning.
    const wiredDecor: ReadonlyArray<readonly [string, string]> = [
      ['potted-plant', 'welcome-room-potted-plant'],
      ['broker-side-table', 'welcome-room-side-table'],
      ['lounge-stool', 'welcome-room-lounge-stool'],
    ];
    for (const [propId, requestId] of wiredDecor) {
      const base = room.props.find((p) => p.id === propId)!.layers[0]!.sprite;
      expect(base.source).toBe('catalog');
      expect((base as { spriteId: string }).spriteId).toMatch(
        new RegExp(`^${requestId}-var-\\d+$`),
      );
    }
    // No hero prop is a placeholder — the reception/hero furniture is all shipped.
    for (const id of [
      'welcome-rug',
      'welcome-desk',
      'shop-table',
      'broker-bookcase',
      'velvet-rope',
    ]) {
      const prop = room.props.find((p) => p.id === id)!;
      expect(prop.layers.some((l) => isCustomSpriteRef(l.sprite))).toBe(false);
    }

    // Hero furniture stays pinned to approved generated variants.
    const rugBase = room.props.find((p) => p.id === 'welcome-rug')!.layers[0]!.sprite;
    expect(rugBase.source).toBe('catalog');
    if (rugBase.source !== 'catalog') {
      throw new Error('welcome-rug base sprite is not a catalog ref');
    }
    expect(rugBase.spriteId).toBe('welcome-room-rug-var-0');

    // Remaining hero props keep exact generated variants
    // (the velvet rope shipped as var-2, the rest as var-0).
    const baseSpriteId = (propId: string): string => {
      const prop = room.props.find((p) => p.id === propId)!;
      const { sprite } = prop.layers[0]!;
      if (sprite.source !== 'catalog') {
        throw new Error(`${propId} base layer is not a catalog ref`);
      }
      return sprite.spriteId;
    };
    expect(baseSpriteId('welcome-desk')).toBe('welcome-room-desk-var-0');
    expect(baseSpriteId('shop-table')).toBe('welcome-room-shop-table-var-0');
    expect(baseSpriteId('broker-bookcase')).toBe('welcome-room-bookcase-var-0');
    expect(baseSpriteId('velvet-rope')).toBe('welcome-room-velvet-rope-var-2');
  });

  it('anchors the reception against the back wall via a top placement', () => {
    const room = getSetPieceDef('welcome-room')!;
    expect(room.placement?.verticalAlign).toBe('top');
  });

  it('mounts wall sconces on the back-wall row and lifts them onto the wall', () => {
    const room = getSetPieceDef('welcome-room')!;
    const sconces = room.props.filter((p) => p.id.startsWith('sconce-'));
    expect(sconces.length).toBeGreaterThan(0);
    expect(room.props.some((p) => p.id.startsWith('torch-'))).toBe(false);
    for (const sconce of sconces) {
      // Authored at the back-wall band (integer or sub-tile top row variants).
      expect(sconce.y).toBeGreaterThanOrEqual(0);
      expect(sconce.y).toBeLessThanOrEqual(1);
      // ...and lifted up off the floor onto the wall with a negative feet nudge.
      expect(sconce.layers[0]?.offsetYFt).toBeLessThan(0);
    }
    // Right-side sconces (when present) mirror via flipX for symmetry.
    const right = sconces.filter((p) => p.id.includes('right'));
    if (right.length > 0) {
      expect(right.every((p) => p.layers[0]?.flipX === true)).toBe(true);
    }
  });

  it('gives every hero furniture prop an explicit feet box so nothing stretches', () => {
    const room = getSetPieceDef('welcome-room')!;
    for (const id of [
      'welcome-rug',
      'welcome-desk',
      'shop-table',
      'broker-bookcase',
      'velvet-rope',
    ]) {
      const layer = room.props.find((p) => p.id === id)!.layers[0]!;
      expect(layer.widthFt).toBeGreaterThan(0);
      expect(layer.heightFt).toBeGreaterThan(0);
    }
  });
});

describe('sprite layer feet + flip schema', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  const packWithLayer = (layer: Record<string, unknown>) => ({
    version: 1,
    packId: 'feet-test',
    setPieces: [
      {
        id: 'feet-room',
        name: 'Feet Room',
        theme: 'test',
        sizing: 'exact',
        width: 2,
        height: 2,
        description: 'Exercises the per-layer feet + flip fields.',
        props: [
          {
            id: 'p',
            kind: 'decoration',
            x: 0,
            y: 0,
            layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 }, ...layer }],
          },
        ],
      },
    ],
  });

  it('accepts a widthFt/heightFt pair plus flip + feet offsets', () => {
    const pack = setPiecePackSchema.parse(
      packWithLayer({ widthFt: 1.5, heightFt: 1.5, offsetXFt: 1, offsetYFt: -4, flipX: true }),
    );
    installSetPiecePacks([pack]);
    const layer = getSetPieceDef('feet-room')!.props[0]!.layers[0]!;
    expect(layer.widthFt).toBe(1.5);
    expect(layer.heightFt).toBe(1.5);
    expect(layer.offsetYFt).toBe(-4);
    expect(layer.flipX).toBe(true);
  });

  it('rejects a widthFt without a matching heightFt (both-or-neither)', () => {
    expect(() => setPiecePackSchema.parse(packWithLayer({ widthFt: 3 }))).toThrow(
      /widthFt and heightFt must be supplied together/,
    );
    expect(() => setPiecePackSchema.parse(packWithLayer({ heightFt: 3 }))).toThrow(
      /widthFt and heightFt must be supplied together/,
    );
  });

  it('rejects a non-positive feet box', () => {
    expect(() => setPiecePackSchema.parse(packWithLayer({ widthFt: 0, heightFt: 2 }))).toThrow();
  });
});

describe('set-piece placement schema', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  const packWithPlacement = (placement: unknown) => ({
    version: 1,
    packId: 'placement-test',
    setPieces: [
      {
        id: 'placed-room',
        name: 'Placed Room',
        theme: 'test',
        sizing: 'exact',
        width: 2,
        height: 2,
        description: 'Exercises the set-piece placement anchor.',
        ...(placement !== undefined ? { placement } : {}),
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
  });

  it('defaults placement to undefined (centre/centre behaviour)', () => {
    installSetPiecePacks([setPiecePackSchema.parse(packWithPlacement(undefined))]);
    expect(getSetPieceDef('placed-room')!.placement).toBeUndefined();
  });

  it('carries an authored vertical + horizontal alignment through compile', () => {
    installSetPiecePacks([
      setPiecePackSchema.parse(
        packWithPlacement({ verticalAlign: 'top', horizontalAlign: 'right' }),
      ),
    ]);
    const def = getSetPieceDef('placed-room')!;
    expect(def.placement).toEqual({ verticalAlign: 'top', horizontalAlign: 'right' });
  });

  it('rejects an unknown alignment value', () => {
    expect(() =>
      setPiecePackSchema.parse(packWithPlacement({ verticalAlign: 'middle' })),
    ).toThrow();
  });
});

describe('set-piece door slots', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  const layers = [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }];

  // 4×4 room; the ring is every tile with x/y at 0 or 3. A door prop sits on the
  // bottom-centre ring tile (1,3); an optional interior floor keeps the interior valid.
  const packWith = (opts: {
    doorAt?: { x: number; y: number };
    doorSlots?: unknown;
    extraProps?: unknown[];
  }) => {
    const door = opts.doorAt ?? { x: 1, y: 3 };
    return {
      version: 1,
      packId: 'door-slot-test',
      setPieces: [
        {
          id: 'door-room',
          name: 'Door Room',
          theme: 'test',
          sizing: 'exact',
          width: 4,
          height: 4,
          description: 'Exercises the door-slot schema + resolver.',
          props: [
            { id: 'entrance', kind: 'door', x: door.x, y: door.y, layers },
            ...(opts.extraProps ?? []),
          ],
          ...(opts.doorSlots !== undefined ? { doorSlots: opts.doorSlots } : {}),
        },
      ],
    };
  };

  it('treats a ring door prop with no slot as an implicit fixed door', () => {
    installSetPiecePacks([setPiecePackSchema.parse(packWith({}))]);
    const slots = resolveSetPieceDoorSlots(getSetPieceDef('door-room')!);
    expect(slots).toEqual([{ propId: 'entrance', mode: 'fixed', x: 1, y: 3, width: 1, height: 1 }]);
  });

  it('upgrades a door to dynamic with eligible edges via a slot', () => {
    installSetPiecePacks([
      setPiecePackSchema.parse(
        packWith({
          doorSlots: [{ propId: 'entrance', mode: 'dynamic', edges: ['bottom', 'left'] }],
        }),
      ),
    ]);
    const slots = resolveSetPieceDoorSlots(getSetPieceDef('door-room')!);
    expect(slots).toEqual([
      {
        propId: 'entrance',
        mode: 'dynamic',
        edges: ['bottom', 'left'],
        x: 1,
        y: 3,
        width: 1,
        height: 1,
      },
    ]);
  });

  it('excludes door props that sit off the ring (interior doors)', () => {
    installSetPiecePacks([setPiecePackSchema.parse(packWith({ doorAt: { x: 2, y: 2 } }))]);
    expect(resolveSetPieceDoorSlots(getSetPieceDef('door-room')!)).toEqual([]);
  });

  it('rejects a dynamic slot with no eligible edges', () => {
    expect(() =>
      setPiecePackSchema.parse(packWith({ doorSlots: [{ propId: 'entrance', mode: 'dynamic' }] })),
    ).toThrow(/at least one eligible edge/);
  });

  it('rejects a fixed slot that declares edges', () => {
    expect(() =>
      setPiecePackSchema.parse(
        packWith({ doorSlots: [{ propId: 'entrance', mode: 'fixed', edges: ['top'] }] }),
      ),
    ).toThrow(/must not declare edges/);
  });

  it('rejects a slot referencing a non-door prop', () => {
    expect(() =>
      setPiecePackSchema.parse(
        packWith({
          extraProps: [{ id: 'shelf', kind: 'furniture', x: 1, y: 1, layers }],
          doorSlots: [{ propId: 'shelf', mode: 'fixed' }],
        }),
      ),
    ).toThrow(/unknown door prop/);
  });

  it('rejects a slot referencing an off-ring door prop', () => {
    expect(() =>
      setPiecePackSchema.parse(
        packWith({ doorAt: { x: 2, y: 2 }, doorSlots: [{ propId: 'entrance', mode: 'fixed' }] }),
      ),
    ).toThrow(/must be a 1×1 door with origin on the .* footprint ring/);
  });

  it('rejects a slot referencing a multi-tile door prop', () => {
    expect(() =>
      setPiecePackSchema.parse(
        packWith({
          extraProps: [{ id: 'wide-door', kind: 'door', x: 1, y: 3, width: 2, layers }],
          doorSlots: [{ propId: 'wide-door', mode: 'fixed' }],
        }),
      ),
    ).toThrow(/must be a 1×1 door with origin on the .* footprint ring/);
  });

  it('rejects duplicate slots for the same door prop', () => {
    expect(() =>
      setPiecePackSchema.parse(
        packWith({
          doorSlots: [
            { propId: 'entrance', mode: 'fixed' },
            { propId: 'entrance', mode: 'dynamic', edges: ['top'] },
          ],
        }),
      ),
    ).toThrow(/Duplicate door slot/);
  });

  it('excludes implicit multi-tile door props from resolved slots', () => {
    installSetPiecePacks([
      setPiecePackSchema.parse(
        packWith({
          extraProps: [{ id: 'wide-door', kind: 'door', x: 1, y: 3, width: 2, layers }],
        }),
      ),
    ]);
    expect(resolveSetPieceDoorSlots(getSetPieceDef('door-room')!)).toEqual([
      { propId: 'entrance', mode: 'fixed', x: 1, y: 3, width: 1, height: 1 },
    ]);
  });
});
