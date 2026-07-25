import { describe, expect, it } from 'vitest';
import type { SetPieceDef, SetPiecePropDef } from '../../../src/shared/set-piece-types.js';
import {
  DEFAULT_THRESHOLDS,
  FEET_PER_TILE,
  scoreSetPiece,
  spriteKey,
  type CompositionThresholds,
} from '../../../scripts/agent/set-piece/composition-score.js';

/** Minimal prop builder so each test states only what it is exercising. */
function prop(
  overrides: Partial<SetPiecePropDef> & Pick<SetPiecePropDef, 'id' | 'kind'>,
): SetPiecePropDef {
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    z: 0,
    layers: [{ sprite: { source: 'catalog', spriteId: 'stub' } }],
    ...overrides,
  } as SetPiecePropDef;
}

function def(overrides: Partial<SetPieceDef> = {}): SetPieceDef {
  return {
    id: 'test-room',
    name: 'Test Room',
    theme: 'test',
    sizing: 'exact',
    width: 6,
    height: 6,
    description: 'fixture',
    tags: [],
    props: [],
    npcs: [],
    ...overrides,
  } as SetPieceDef;
}

const checkOf = (d: SetPieceDef, id: string, t?: CompositionThresholds) => {
  const found = scoreSetPiece(d, t).checks.find((c) => c.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
};

/** Fills the whole room with a single stamped floor sprite (the slop baseline). */
function uniformFloor(width: number, height: number): SetPiecePropDef[] {
  const props: SetPiecePropDef[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      props.push(
        prop({
          id: `floor-${x}-${y}`,
          kind: 'floor',
          x,
          y,
          layers: [{ sprite: { source: 'sheet', sheetKey: 'kenney', col: 11, row: 20 } }],
        }),
      );
    }
  }
  return props;
}

describe('spriteKey', () => {
  it('distinguishes every sprite source', () => {
    expect(spriteKey({ source: 'catalog', spriteId: 'rug' })).toBe('catalog:rug');
    expect(spriteKey({ source: 'sheet', sheetKey: 'kenney', col: 1, row: 2 })).toBe(
      'sheet:kenney:1:2',
    );
    expect(
      spriteKey({ source: 'custom', requestId: 'neon-sign', label: 'Neon', prompt: 'p' }),
    ).toBe('custom:neon-sign');
  });
});

describe('occupancy', () => {
  it('does not count floor or wall structure as dressing', () => {
    // An empty box with a full floor and a complete wall ring must still fail:
    // this is the exact shape of the generated rooms the gate exists to reject.
    const walls: SetPiecePropDef[] = [];
    for (let i = 0; i < 6; i += 1) {
      walls.push(prop({ id: `w-top-${i}`, kind: 'wall', x: i, y: 0 }));
      walls.push(prop({ id: `w-bot-${i}`, kind: 'wall', x: i, y: 5 }));
    }
    const check = checkOf(def({ props: [...uniformFloor(6, 6), ...walls] }), 'occupancy');
    expect(check.pass).toBe(false);
    expect(check.actual).toBe(0);
  });

  it('passes once enough non-structural props are placed', () => {
    const clutter = Array.from({ length: 9 }, (_, i) =>
      prop({ id: `c${i}`, kind: 'furniture', x: i % 3, y: Math.floor(i / 3) }),
    );
    expect(checkOf(def({ props: clutter }), 'occupancy').pass).toBe(true);
  });
});

describe('stacking', () => {
  it('rewards overlapping props on the same tile', () => {
    const props = [
      ...Array.from({ length: 8 }, (_, i) =>
        prop({ id: `c${i}`, kind: 'furniture', x: i % 4, y: Math.floor(i / 4) }),
      ),
      prop({ id: 'plate', kind: 'decoration', x: 0, y: 0 }),
    ];
    const check = checkOf(def({ props }), 'stacking');
    expect(check.actual).toBeGreaterThan(0);
  });

  it('fails a flat layout with no nesting', () => {
    const props = Array.from({ length: 9 }, (_, i) =>
      prop({ id: `c${i}`, kind: 'furniture', x: i % 3, y: Math.floor(i / 3) }),
    );
    expect(checkOf(def({ props }), 'stacking').pass).toBe(false);
  });

  it('counts a composite prop with extra sprite layers as nesting', () => {
    const flat = Array.from({ length: 8 }, (_, i) =>
      prop({ id: `c${i}`, kind: 'furniture', x: i % 4, y: Math.floor(i / 4) }),
    );
    const composite = prop({
      id: 'table',
      kind: 'furniture',
      x: 0,
      y: 0,
      layers: [
        { sprite: { source: 'catalog', spriteId: 'table' }, widthFt: 4, heightFt: 2 },
        { sprite: { source: 'catalog', spriteId: 'potion' }, widthFt: 1, heightFt: 1 },
      ],
    });
    const withComposite = checkOf(def({ props: [...flat.slice(1), composite] }), 'stacking');
    const withoutComposite = checkOf(def({ props: flat }), 'stacking');
    expect(withComposite.actual).toBeGreaterThan(withoutComposite.actual);
  });

  it('does not credit extra layers to tiles outside the prop footprint', () => {
    const composite = prop({
      id: 'table',
      kind: 'furniture',
      x: 0,
      y: 0,
      layers: [
        { sprite: { source: 'catalog', spriteId: 'table' } },
        // Offset far outside the 1x1 footprint: must not create a stacked tile.
        { sprite: { source: 'catalog', spriteId: 'lamp' }, offsetXFt: 20, offsetYFt: 20 },
      ],
    });
    expect(checkOf(def({ props: [composite] }), 'stacking').actual).toBe(0);
  });
});

describe('floor variety', () => {
  it('fails a single stamped floor sprite', () => {
    const check = checkOf(def({ props: uniformFloor(6, 6) }), 'floor-variety');
    expect(check.pass).toBe(false);
    expect(check.actual).toBe(1);
  });

  it('passes with enough evenly spread variants', () => {
    const props: SetPiecePropDef[] = [];
    for (let i = 0; i < 9; i += 1) {
      props.push(
        prop({
          id: `f${i}`,
          kind: 'floor',
          x: i % 3,
          y: Math.floor(i / 3),
          layers: [{ sprite: { source: 'catalog', spriteId: `tile-${i % 3}` } }],
        }),
      );
    }
    expect(checkOf(def({ props }), 'floor-variety').pass).toBe(true);
  });
});

describe('anti-grid', () => {
  it('flags an evenly spaced row of props', () => {
    const row = Array.from({ length: 5 }, (_, i) =>
      prop({ id: `r${i}`, kind: 'furniture', x: i, y: 2 }),
    );
    const check = checkOf(def({ props: row }), 'anti-grid');
    expect(check.pass).toBe(false);
    expect(check.actual).toBe(1);
  });

  it('accepts a staggered arrangement', () => {
    const props = [
      prop({ id: 'a', kind: 'furniture', x: 0, y: 0 }),
      prop({ id: 'b', kind: 'furniture', x: 2, y: 1 }),
      prop({ id: 'c', kind: 'furniture', x: 3, y: 3 }),
      prop({ id: 'd', kind: 'decoration', x: 1, y: 4 }),
    ];
    expect(checkOf(def({ props }), 'anti-grid').pass).toBe(true);
  });
});

describe('real-world scale', () => {
  it('fails props with no declared feet', () => {
    const props = [prop({ id: 'desk', kind: 'furniture', x: 1, y: 1 })];
    const check = checkOf(def({ props }), 'real-world-scale');
    expect(check.pass).toBe(false);
    expect(check.detail).toContain(`1 tile = ${FEET_PER_TILE} ft`);
  });

  it('passes when every non-floor prop declares feet', () => {
    const props = [
      prop({
        id: 'desk',
        kind: 'furniture',
        x: 1,
        y: 1,
        layers: [{ sprite: { source: 'catalog', spriteId: 'desk' }, widthFt: 5, heightFt: 2.5 }],
      }),
    ];
    expect(checkOf(def({ props }), 'real-world-scale').pass).toBe(true);
  });
});

describe('focal point', () => {
  it('fails when every prop is the same size', () => {
    const props = Array.from({ length: 4 }, (_, i) =>
      prop({
        id: `p${i}`,
        kind: 'furniture',
        x: i,
        y: 0,
        layers: [{ sprite: { source: 'catalog', spriteId: 'x' }, widthFt: 2, heightFt: 2 }],
      }),
    );
    expect(checkOf(def({ props }), 'focal-point').pass).toBe(false);
  });

  it('passes when one prop dominates the composition', () => {
    const props = [
      prop({
        id: 'counter',
        kind: 'furniture',
        x: 0,
        y: 0,
        layers: [{ sprite: { source: 'catalog', spriteId: 'counter' }, widthFt: 10, heightFt: 3 }],
      }),
      ...Array.from({ length: 3 }, (_, i) =>
        prop({
          id: `s${i}`,
          kind: 'decoration',
          x: i + 2,
          y: 3,
          layers: [{ sprite: { source: 'catalog', spriteId: 's' }, widthFt: 1.5, heightFt: 1.5 }],
        }),
      ),
    ];
    expect(checkOf(def({ props }), 'focal-point').pass).toBe(true);
  });
});

describe('wall anchoring', () => {
  const bulky = (id: string, x: number, y: number) =>
    prop({
      id,
      kind: 'furniture',
      x,
      y,
      layers: [{ sprite: { source: 'catalog', spriteId: 'bulk' }, widthFt: 8, heightFt: 3 }],
    });
  const trinket = (id: string, x: number, y: number) =>
    prop({
      id,
      kind: 'decoration',
      x,
      y,
      layers: [{ sprite: { source: 'catalog', spriteId: 't' }, widthFt: 1.5, heightFt: 1.5 }],
    });

  it('fails when bulk furniture floats in open floor', () => {
    // 6x5 room: every large prop sits strictly inside the wall ring.
    const props = [bulky('a', 2, 2), bulky('b', 3, 2), trinket('t1', 1, 1), trinket('t2', 4, 3)];
    const check = checkOf(def({ props }), 'wall-anchoring');
    expect(check.pass).toBe(false);
    expect(check.actual).toBe(0);
  });

  it('passes when bulk furniture is pushed against the walls', () => {
    const props = [bulky('a', 0, 0), bulky('b', 0, 4), trinket('t1', 2, 2), trinket('t2', 3, 2)];
    const check = checkOf(def({ props }), 'wall-anchoring');
    expect(check.pass).toBe(true);
  });

  it('judges size relative to the room, not against a fixed footprint', () => {
    // All props tiny, but the two largest are wall-anchored: still passes.
    const props = [
      trinket('big-a', 0, 0),
      trinket('big-b', 5, 4),
      prop({
        id: 'tiny',
        kind: 'decoration',
        x: 2,
        y: 2,
        layers: [{ sprite: { source: 'catalog', spriteId: 't' }, widthFt: 0.5, heightFt: 0.5 }],
      }),
    ];
    expect(checkOf(def({ props }), 'wall-anchoring').pass).toBe(true);
  });
});

describe('shell integrity', () => {
  const ringOf = (
    w: number,
    h: number,
    opts: { doorAt?: { x: number; y: number }; gap?: boolean },
  ) => {
    const props = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x !== 0 && y !== 0 && x !== w - 1 && y !== h - 1) continue;
        if (opts.gap === true && x === 2 && y === 0) continue;
        const isDoor = opts.doorAt !== undefined && opts.doorAt.x === x && opts.doorAt.y === y;
        props.push(
          prop({
            id: `${isDoor ? 'door' : 'wall'}-${x}-${y}`,
            kind: isDoor ? 'door' : 'wall',
            x,
            y,
            layers: [{ sprite: { source: 'catalog', spriteId: 'w' }, widthFt: 2, heightFt: 2 }],
          }),
        );
      }
    }
    return props;
  };

  it('fails a complete ring with no door — a sealed, unreachable room', () => {
    const check = checkOf(def({ width: 6, height: 5, props: ringOf(6, 5, {}) }), 'shell-integrity');
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('no door prop sits on the perimeter');
  });

  it('fails a gapped ring even when a door is present', () => {
    const props = ringOf(6, 5, { doorAt: { x: 3, y: 0 }, gap: true });
    const check = checkOf(def({ width: 6, height: 5, props }), 'shell-integrity');
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('perimeter tile(s) have no wall or door prop');
  });

  it('fails when the only door sits in the interior instead of on the ring', () => {
    const props = [
      ...ringOf(6, 5, {}),
      prop({
        id: 'floating-door',
        kind: 'door',
        x: 3,
        y: 2,
        layers: [{ sprite: { source: 'catalog', spriteId: 'd' }, widthFt: 2, heightFt: 2 }],
      }),
    ];
    const check = checkOf(def({ width: 6, height: 5, props }), 'shell-integrity');
    expect(check.pass).toBe(false);
    expect(check.actual).toBe(0);
  });

  it('passes a complete ring with a door on it', () => {
    const props = ringOf(6, 5, { doorAt: { x: 3, y: 0 } });
    const check = checkOf(def({ width: 6, height: 5, props }), 'shell-integrity');
    expect(check.pass).toBe(true);
    expect(check.actual).toBe(1);
  });
});

describe('circulation', () => {
  it('fails when clutter walls an NPC off from the door', () => {
    // Solid furniture spans the full width at y=3, splitting the room in two.
    const barrier = Array.from({ length: 6 }, (_, x) =>
      prop({ id: `bar-${x}`, kind: 'furniture', x, y: 3 }),
    );
    const d = def({
      props: [...barrier, prop({ id: 'door', kind: 'door', x: 0, y: 0 })],
      npcs: [{ id: 'shopkeep', npcTypeId: 'shopkeeper', x: 3, y: 5 }],
    } as Partial<SetPieceDef>);
    expect(checkOf(d, 'circulation').pass).toBe(false);
  });

  it('passes when a 2-wide path connects the anchors', () => {
    const d = def({
      props: [
        prop({ id: 'door', kind: 'door', x: 0, y: 0 }),
        prop({ id: 'table', kind: 'furniture', x: 2, y: 2 }),
      ],
      npcs: [{ id: 'shopkeep', npcTypeId: 'shopkeeper', x: 4, y: 4 }],
    } as Partial<SetPieceDef>);
    expect(checkOf(d, 'circulation').pass).toBe(true);
  });
});

describe('anchor sanity', () => {
  it('fails an NPC standing inside solid furniture', () => {
    const d = def({
      props: [prop({ id: 'crate', kind: 'furniture', x: 2, y: 2 })],
      npcs: [{ id: 'ghost', npcTypeId: 'shopkeeper', x: 2, y: 2 }],
    } as Partial<SetPieceDef>);
    const check = checkOf(d, 'anchor-sanity');
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('ghost');
  });

  it('passes when anchors stand clear', () => {
    const d = def({
      props: [prop({ id: 'crate', kind: 'furniture', x: 2, y: 2 })],
      npcs: [{ id: 'clerk', npcTypeId: 'shopkeeper', x: 4, y: 4 }],
    } as Partial<SetPieceDef>);
    expect(checkOf(d, 'anchor-sanity').pass).toBe(true);
  });
});

describe('scoreSetPiece', () => {
  it('is deterministic across repeated runs', () => {
    const d = def({ props: uniformFloor(6, 6) });
    expect(scoreSetPiece(d)).toEqual(scoreSetPiece(d));
  });

  it('reports every check and aggregates the verdict', () => {
    const report = scoreSetPiece(def({ props: uniformFloor(6, 6) }));
    expect(report.totalCount).toBe(report.checks.length);
    expect(report.passedCount).toBe(report.checks.filter((c) => c.pass).length);
    expect(report.passed).toBe(report.passedCount === report.totalCount);
  });

  it('honours overridden thresholds without changing logic', () => {
    const props = Array.from({ length: 4 }, (_, i) =>
      prop({ id: `c${i}`, kind: 'furniture', x: i, y: 0 }),
    );
    const strict = checkOf(def({ props }), 'occupancy', DEFAULT_THRESHOLDS);
    const lenient = checkOf(def({ props }), 'occupancy', {
      ...DEFAULT_THRESHOLDS,
      minOccupancy: 0.05,
    });
    expect(strict.pass).toBe(false);
    expect(lenient.pass).toBe(true);
    expect(strict.actual).toBeCloseTo(lenient.actual);
  });
});
