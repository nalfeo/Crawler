import { addComponent, addEntity, removeComponent, removeEntity } from 'bitecs';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import {
  DeathTimer,
  Enemy,
  Gold,
  Harvestable,
  Npc,
  Player,
  Position,
  Prop,
  Rotation,
  Spawner,
  Sprite,
  Velocity,
  XpGem,
} from '../../src/core/components.js';
import { HARVESTABLE_DEFS } from '../../src/shared/harvestableDefs.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { RAT_BRUTE_TINT } from '../../src/engine/phaser-bridge/sprite-kind.js';
import { ENTITY_DEPTH, TERRAIN_DEPTH, WORLD_VFX_DEPTH } from '../../src/shared/render-depths.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { set } from '../../src/core/world.js';
import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import {
  createSceneStub,
  createBridgeTestMap,
  MockImage,
  MockGraphics,
} from '../fixtures/phaser-bridge-harness.js';
import { spawnMeleeSwing } from '../../src/core/spawners/melee.js';
import { addSetPieceProp } from '../../src/core/spawners/world-objects.js';
import { setPieceZToDepth } from '../../src/shared/render-depths.js';
import { MeleeSpriteId } from '../../src/shared/constants.js';
import { getSprite } from '../../src/engine/sprites/index.js';
import { DECORATION_DEF_INDEX } from '../../src/shared/decorationDefs.js';
import { flattenSetPieceLayers, getSetPieceDef } from '../../src/shared/set-piece-types.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import { startEnemyProjectileTelegraph } from '../../src/core/systems/enemyTelegraph.js';
import { sampleContactAttackMotion } from '../../src/shared/mob-motion.js';
import { ftToPx } from '../../src/shared/units.js';

/**
 * Faithful local stand-in for a Phaser weapon image on the melee-swing render
 * path. Unlike the shared `MockImage` (whose `frame` is a raw number), this
 * models `frame` as `{ name }` — matching how production reads
 * `img.frame?.name` — and counts `setTexture` calls so a test can assert the
 * mid-swing reconcile guard only re-applies the texture when it actually
 * changes. This is the regression net for the every-frame re-apply bug where a
 * `loader.image` texture's frame is named `'__BASE'` (never `undefined`), so
 * the old `'__BASE' !== undefined` compare stayed true forever.
 */
class SwingImage {
  setTextureCalls = 0;
  visible = true;
  alpha = 1;
  scaleX = 1;
  originX = 0.5;
  originY = 0.5;
  rotation = 0;
  frame: { name: string | number };

  constructor(
    public x: number,
    public y: number,
    public textureKey: string,
    frame?: number,
  ) {
    this.frame = { name: frame ?? '__BASE' };
  }

  get texture(): { key: string } {
    return { key: this.textureKey };
  }

  setTexture(key: string, frame?: number): this {
    this.setTextureCalls += 1;
    this.textureKey = key;
    this.frame = { name: frame ?? '__BASE' };
    return this;
  }

  setOrigin(x: number, y: number): this {
    this.originX = x;
    this.originY = y;
    return this;
  }

  setScale(x: number): this {
    this.scaleX = x;
    return this;
  }

  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  setRotation(r: number): this {
    this.rotation = r;
    return this;
  }

  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }

  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
}

class PropRect {
  destroyed = false;
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  depth = 0;

  constructor(x: number, y: number, width: number, height: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  setSize(width: number, height: number): this {
    this.width = width;
    this.height = height;
    return this;
  }

  setFillStyle(_color: number, _alpha = 1): this {
    return this;
  }

  setDepth(depth: number): this {
    this.depth = depth;
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/**
 * Minimal scene whose generated-sprite registry knows about the approved
 * `baseball-bat-v1` art. `readyKeys` controls which texture keys report as
 * loaded via `textures.exists`, letting a test simulate the generated PNG
 * finishing its async load mid-swing.
 */
function makeBatSwingScene(readyKeys: Set<string>): {
  scene: Phaser.Scene;
  images: SwingImage[];
} {
  const images: SwingImage[] = [];
  const registry = buildGeneratedSpriteRegistry({
    version: 1,
    entries: {
      'baseball-bat-v1-var-0': {
        briefId: 'baseball-bat-v1',
        spriteName: 'baseball-bat-v1-var-0',
        assetPath: 'generated/baseball-bat-v1-var-0.png',
        approvedAt: '2026-07-01T00:00:00.000Z',
        sourceRun: 'test-run',
        variantIndex: 0,
        anchor: { x: 32, y: 60, source: 'brief' },
        sensorScore: '8/8',
        judgeScore: '2',
      },
    },
  });
  const scene = {
    game: { registry: { get: () => registry } },
    add: {
      image: vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
        const img = new SwingImage(x, y, textureKey, frame);
        images.push(img);
        return img as unknown as Phaser.GameObjects.Image;
      }),
      graphics: vi.fn(() => new MockGraphics() as unknown as Phaser.GameObjects.Graphics),
    },
    textures: {
      // generateTextures() early-returns when the player texture already
      // exists, so report every procedural/Kenney key as present and let
      // `readyKeys` govern only the generated bat texture (the async load we
      // want to simulate).
      exists: (key: string) => (key === 'baseball-bat-v1-var-0' ? readyKeys.has(key) : true),
      get: () => ({ getSourceImage: () => ({ width: 64, height: 64 }) }),
    },
  } as unknown as Phaser.Scene;
  return { scene, images };
}

describe('createPhaserBridge', () => {
  it('handles empty worlds without creating game objects', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    bridge.sync(world);

    expect(images).toHaveLength(0);
  });

  it('creates and updates images for sprite-position entities', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 10, y: 20 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      x: 80,
      y: 160,
      destroyed: false,
    });

    world.stores.position.x[eid] = 30;
    world.stores.position.y[eid] = 40;

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ x: 240, y: 320 });
  });

  it('applies per-instance NPC flip and rotation transforms from runtime metadata', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 10, y: 20 }));
    addComponent(world.ecs, eid, Npc);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 4, height: 5 }));
    world.npcs.set(eid, {
      defId: 'tutorial-goon',
      spriteOverride: { source: 'catalog', spriteId: 'sprite:npc.guide' },
      flipX: true,
      flipY: true,
      rotationDeg: 90,
      z: 6,
      dialogueIndex: 0,
      quests: [],
      nearbyPlayer: false,
    });

    bridge.sync(world);
    expect(images).toHaveLength(1);
    expect(images[0]?.flipX).toBe(true);
    expect(images[0]?.flipY).toBe(true);
    expect(images[0]?.rotation).toBeCloseTo(Math.PI * 0.5);
    expect(typeof images[0]?.frame).toBe('number');
    expect(images[0]?.displayWidth).toBeCloseTo(32);
    expect(images[0]?.displayHeight).toBeCloseTo(40);
    expect(images[0]?.depth).toBeCloseTo(setPieceZToDepth(6));

    const instance = world.npcs.get(eid)!;
    instance.flipX = false;
    instance.flipY = false;
    instance.rotationDeg = 0;
    instance.z = -4;
    bridge.sync(world);
    expect(images[0]?.flipX).toBe(false);
    expect(images[0]?.flipY).toBe(false);
    expect(images[0]?.rotation).toBeCloseTo(0);
    expect(images[0]?.depth).toBeCloseTo(TERRAIN_DEPTH + 0.001);
  });

  it('destroys images when entities disappear or the bridge is destroyed', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 1, y: 2 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 12, height: 12 }));

    bridge.sync(world);
    expect(images).toHaveLength(1);

    removeEntity(world.ecs, eid);
    bridge.sync(world);

    expect(images[0]?.destroyed).toBe(true);

    const secondEid = addEntity(world.ecs);
    addComponent(world.ecs, secondEid, set(Position, { x: 5, y: 6 }));
    addComponent(world.ecs, secondEid, set(Sprite, { textureId: 0, width: 12, height: 12 }));

    bridge.sync(world);
    expect(images).toHaveLength(2);

    bridge.destroy();

    expect(images[1]?.destroyed).toBe(true);
  });

  it('renders props as sprites when texture exists and falls back to rectangles otherwise', () => {
    const propImages: MockImage[] = [];
    const propRects: PropRect[] = [];
    const scene = {
      add: {
        image: vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
          const img = new MockImage(x, y, textureKey, frame);
          (
            img as unknown as { setDisplaySize: (w: number, h: number) => MockImage }
          ).setDisplaySize = function setDisplaySize(_w: number, _h: number): MockImage {
            return img;
          };
          propImages.push(img);
          return img as unknown as Phaser.GameObjects.Image;
        }),
        rectangle: vi.fn((x = 0, y = 0, width = 0, height = 0) => {
          const rect = new PropRect(x, y, width, height);
          propRects.push(rect);
          return rect as unknown as Phaser.GameObjects.Rectangle;
        }),
      },
      textures: {
        exists: (key: string) =>
          key === 'prop-wall-sconce-v1-var-1' || key === 'prop-rubble-pile-var-1',
      },
    } as unknown as Phaser.Scene;

    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    const renderedProp = addEntity(world.ecs);
    addComponent(world.ecs, renderedProp, Prop);
    addComponent(world.ecs, renderedProp, set(Position, { x: 1, y: 2 }));
    world.stores.prop.defIdIndex[renderedProp] = DECORATION_DEF_INDEX['wall-sconce']!;

    const placeholderProp = addEntity(world.ecs);
    addComponent(world.ecs, placeholderProp, Prop);
    addComponent(world.ecs, placeholderProp, set(Position, { x: 3, y: 4 }));
    world.stores.prop.defIdIndex[placeholderProp] = DECORATION_DEF_INDEX['junk-pile']!;

    // Rubble is wired to real generated art (prop-rubble-pile-var-1); it must
    // render as a sprite, not the placeholder rectangle it used to fall back to.
    const rubbleProp = addEntity(world.ecs);
    addComponent(world.ecs, rubbleProp, Prop);
    addComponent(world.ecs, rubbleProp, set(Position, { x: 5, y: 6 }));
    world.stores.prop.defIdIndex[rubbleProp] = DECORATION_DEF_INDEX['rubble']!;

    bridge.sync(world);

    expect(propImages.some((img) => img.textureKey === 'prop-wall-sconce-v1-var-1')).toBe(true);
    expect(propImages.some((img) => img.textureKey === 'prop-rubble-pile-var-1')).toBe(true);
    expect(propRects.length).toBeGreaterThan(0);

    bridge.destroy();
    expect(propImages.every((img) => img.destroyed)).toBe(true);
    expect(propRects.every((rect) => rect.destroyed)).toBe(true);
  });

  it('renders set-piece prop layers with straddling depth, footprint and tint', () => {
    const propImages: (MockImage & { displayW?: number; displayH?: number })[] = [];
    const propRects: PropRect[] = [];
    const scene = {
      add: {
        image: vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
          const img = new MockImage(x, y, textureKey, frame) as MockImage & {
            displayW?: number;
            displayH?: number;
          };
          (
            img as unknown as { setDisplaySize: (w: number, h: number) => MockImage }
          ).setDisplaySize = function setDisplaySize(w: number, h: number): MockImage {
            img.displayW = w;
            img.displayH = h;
            return img;
          };
          propImages.push(img);
          return img as unknown as Phaser.GameObjects.Image;
        }),
        rectangle: vi.fn((x = 0, y = 0, width = 0, height = 0) => {
          const rect = new PropRect(x, y, width, height);
          propRects.push(rect);
          return rect as unknown as Phaser.GameObjects.Rectangle;
        }),
      },
      textures: {
        // Only the Kenney tiny-town sheet is "loaded" here.
        exists: (key: string) => key === 'kenney-tiny-town',
      },
    } as unknown as Phaser.Scene;

    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    // A furniture layer (z=30 → foreground) resolved from a loaded Kenney sheet frame.
    const deskDepth = setPieceZToDepth(30);
    addSetPieceProp(world, 3, 2, {
      sprite: { source: 'sheet', sheetKey: 'kenney-tiny-town', col: 2, row: 5 },
      depth: deskDepth,
      widthFt: 12,
      heightFt: 4,
      tintHex: '#7f1d1d',
      label: 'welcome-desk',
    });

    // A background rug layer (z=0) whose custom art is not yet generated → placeholder rect.
    const rugDepth = setPieceZToDepth(0);
    addSetPieceProp(world, 5, 6, {
      sprite: {
        source: 'custom',
        requestId: 'welcome-room-rug',
        label: 'welcome rug',
        prompt: 'a threadbare red rug',
      },
      depth: rugDepth,
      widthFt: 16,
      heightFt: 8,
    });

    bridge.sync(world);

    // Desk: rendered as a sprite (frame = row*cols+col = 5*12+2 = 62) at foreground depth,
    // sized to its footprint (feet → px at 8 px/ft) and tinted.
    const desk = propImages.find((img) => img.textureKey === 'kenney-tiny-town');
    expect(desk).toBeDefined();
    expect(desk?.frame).toBe(62);
    expect(desk?.depth).toBe(deskDepth);
    expect(desk?.depth).toBeGreaterThan(ENTITY_DEPTH);
    expect(desk?.displayW).toBe(96);
    expect(desk?.displayH).toBe(32);
    expect(desk?.tinted).toBe(true);
    expect(desk?.tint).toBe(0x7f1d1d);

    // Rug: no loaded art → placeholder rect in the background band (below entities).
    expect(propRects).toHaveLength(1);
    expect(propRects[0]?.depth).toBe(rugDepth);
    expect(propRects[0]?.depth).toBeLessThan(ENTITY_DEPTH);

    bridge.destroy();
    expect(desk?.destroyed).toBe(true);
    expect(propRects[0]?.destroyed).toBe(true);
  });

  it('applies and then clears set-piece prop-layer rotation on resync', () => {
    const propImages: MockImage[] = [];
    const scene = {
      add: {
        image: vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
          const img = new MockImage(x, y, textureKey, frame);
          propImages.push(img);
          return img as unknown as Phaser.GameObjects.Image;
        }),
        rectangle: vi.fn((x = 0, y = 0, width = 0, height = 0) => {
          const rect = new PropRect(x, y, width, height);
          return rect as unknown as Phaser.GameObjects.Rectangle;
        }),
      },
      textures: { exists: (key: string) => key === 'kenney-tiny-town' },
    } as unknown as Phaser.Scene;

    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    addSetPieceProp(world, 3, 2, {
      sprite: { source: 'sheet', sheetKey: 'kenney-tiny-town', col: 2, row: 5 },
      depth: setPieceZToDepth(30),
      widthFt: 12,
      heightFt: 4,
      rotationDeg: 45,
      label: 'rotated-prop',
    });

    bridge.sync(world);
    expect(propImages).toHaveLength(1);
    expect(propImages[0]?.rotation).toBeCloseTo((45 * Math.PI) / 180);

    world.setPieceProps[0] = {
      ...world.setPieceProps[0]!,
      render: { ...world.setPieceProps[0]!.render, rotationDeg: 0 },
    };
    bridge.sync(world);
    expect(propImages[0]?.rotation).toBeCloseTo(0);
  });

  it('scales upright set-piece art by heightFt alone so a declared height is never flattened', () => {
    // Native art is 100×50 (aspect 2.0). The authored feet box is 10×10 ft →
    // 80×80 px. `heightFt` is AUTHORITATIVE for upright props: the scale is
    // 80/50 = 1.6 so the art's apparent height is exactly the declared 10 ft,
    // and its width follows the art's own 2:1 aspect. It is a single uniform
    // scale, so the sprite is still never stretched.
    //
    // Regression guard: the old contain-fit took min(80/100, 80/50) = 0.8, which
    // silently threw away HALF the declared height. A torch authored at 1.5×3 ft
    // rendered at 1.5 ft. That is what made every authored room read as squashed.
    let displaySizeCalls = 0;
    const propImages: (MockImage & { width: number; height: number })[] = [];
    const scene = {
      add: {
        image: vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
          const img = new MockImage(x, y, textureKey, frame) as MockImage & {
            width: number;
            height: number;
          };
          // A resident texture reports its native pixel size.
          img.width = 100;
          img.height = 50;
          (
            img as unknown as { setDisplaySize: (w: number, h: number) => MockImage }
          ).setDisplaySize = function setDisplaySize(): MockImage {
            displaySizeCalls += 1;
            return img;
          };
          propImages.push(img);
          return img as unknown as Phaser.GameObjects.Image;
        }),
        rectangle: vi.fn((x = 0, y = 0, width = 0, height = 0) => {
          const rect = new PropRect(x, y, width, height);
          return rect as unknown as Phaser.GameObjects.Rectangle;
        }),
      },
      textures: {
        exists: (key: string) => key === 'kenney-tiny-town',
      },
    } as unknown as Phaser.Scene;

    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    addSetPieceProp(world, 3, 2, {
      sprite: { source: 'sheet', sheetKey: 'kenney-tiny-town', col: 2, row: 5 },
      depth: setPieceZToDepth(30),
      widthFt: 10,
      heightFt: 10,
      label: 'aspect-probe',
    });

    bridge.sync(world);

    const img = propImages[0];
    expect(img).toBeDefined();
    // Native size known → NO setDisplaySize distortion.
    expect(displaySizeCalls).toBe(0);
    // Height-authoritative: 80px box / 50px native = 1.6, so the rendered height
    // is the full declared 10 ft rather than the 0.8 (5 ft) contain-fit gave.
    expect(img?.scaleY).toBe(1.6);
    // Uniform scale: scaleX === scaleY (the anti-stretch invariant).
    expect(img?.scaleX).toBe(img?.scaleY);

    bridge.destroy();
  });

  it('contain-fits FLOOR decals so both ground extents are honoured', () => {
    // A rug/stain/tape lies IN the floor plane, so widthFt and heightFt are both
    // real ground extents and must both be respected. Same 100×50 art in the same
    // 10×10 ft box, but marked `floorPlane` → contain-fit min(0.8, 1.6) = 0.8,
    // keeping the decal inside its declared ground footprint.
    let displaySizeCalls = 0;
    const propImages: (MockImage & { width: number; height: number })[] = [];
    const scene = {
      add: {
        image: vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
          const img = new MockImage(x, y, textureKey, frame) as MockImage & {
            width: number;
            height: number;
          };
          img.width = 100;
          img.height = 50;
          (
            img as unknown as { setDisplaySize: (w: number, h: number) => MockImage }
          ).setDisplaySize = function setDisplaySize(): MockImage {
            displaySizeCalls += 1;
            return img;
          };
          propImages.push(img);
          return img as unknown as Phaser.GameObjects.Image;
        }),
        rectangle: vi.fn((x = 0, y = 0, width = 0, height = 0) => {
          const rect = new PropRect(x, y, width, height);
          return rect as unknown as Phaser.GameObjects.Rectangle;
        }),
      },
      textures: {
        exists: (key: string) => key === 'kenney-tiny-town',
      },
    } as unknown as Phaser.Scene;

    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    addSetPieceProp(world, 3, 2, {
      sprite: { source: 'sheet', sheetKey: 'kenney-tiny-town', col: 2, row: 5 },
      depth: setPieceZToDepth(30),
      widthFt: 10,
      heightFt: 10,
      floorPlane: true,
      label: 'floor-decal-probe',
    });

    bridge.sync(world);

    const img = propImages[0];
    expect(img).toBeDefined();
    expect(displaySizeCalls).toBe(0);
    expect(img?.scaleY).toBe(0.8);
    expect(img?.scaleX).toBe(img?.scaleY);

    bridge.destroy();
  });

  it('resolves shipped welcome-room generated catalog props to real art (bare key)', () => {
    // Exact generated manifest keys still used as catalog refs in welcome-room.
    const GENERATED_KEYS = {
      desk: 'welcome-room-desk-var-0',
      shopTable: 'welcome-room-shop-table-var-0',
      bookcase: 'welcome-room-bookcase-var-0',
      velvetRope: 'welcome-room-velvet-rope-var-2',
    } as const;
    const expectedKeys = new Set<string>(Object.values(GENERATED_KEYS));

    // Guard the shipped JSON wiring: the welcome-room def must reference each
    // generated prop as a `catalog` ref pinned to its exact bare manifest key.
    const def = getSetPieceDef('welcome-room');
    expect(def).toBeDefined();
    const layers = flattenSetPieceLayers(def!);
    const catalogSpriteIds = new Set(
      layers
        .map((draw) => draw.layer.sprite)
        .filter((sprite) => sprite.source === 'catalog')
        .map((sprite) => (sprite as { spriteId: string }).spriteId),
    );
    for (const key of expectedKeys) {
      expect(catalogSpriteIds.has(key)).toBe(true);
    }

    // Render path: a `catalog` ref whose generated texture is loaded under its
    // bare manifest key resolves to a real image (no spritesheet frame), never a
    // placeholder rect — even when no Kenney catalog sheet is loaded.
    const propImages: (MockImage & { displayW?: number; displayH?: number })[] = [];
    const propRects: PropRect[] = [];
    const scene = {
      add: {
        image: vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
          const img = new MockImage(x, y, textureKey, frame) as MockImage & {
            displayW?: number;
            displayH?: number;
          };
          (
            img as unknown as { setDisplaySize: (w: number, h: number) => MockImage }
          ).setDisplaySize = function setDisplaySize(w: number, h: number): MockImage {
            img.displayW = w;
            img.displayH = h;
            return img;
          };
          propImages.push(img);
          return img as unknown as Phaser.GameObjects.Image;
        }),
        rectangle: vi.fn((x = 0, y = 0, width = 0, height = 0) => {
          const rect = new PropRect(x, y, width, height);
          propRects.push(rect);
          return rect as unknown as Phaser.GameObjects.Rectangle;
        }),
      },
      textures: {
        // Only the generated welcome-room textures are loaded (bare keys); no
        // Kenney catalog sheet, so resolution must fall through to the bare key.
        exists: (key: string) => expectedKeys.has(key),
      },
    } as unknown as Phaser.Scene;

    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    // Shop table (background band, z=0) + desk (foreground band, z=30).
    addSetPieceProp(world, 5, 6, {
      sprite: { source: 'catalog', spriteId: GENERATED_KEYS.shopTable },
      depth: setPieceZToDepth(0),
      widthFt: 16,
      heightFt: 8,
      label: 'welcome-room-shop-table',
    });
    addSetPieceProp(world, 3, 2, {
      sprite: { source: 'catalog', spriteId: GENERATED_KEYS.desk },
      depth: setPieceZToDepth(30),
      widthFt: 12,
      heightFt: 4,
      label: 'welcome-desk',
    });

    bridge.sync(world);

    const shopTable = propImages.find((img) => img.textureKey === GENERATED_KEYS.shopTable);
    const desk = propImages.find((img) => img.textureKey === GENERATED_KEYS.desk);
    expect(shopTable).toBeDefined();
    expect(desk).toBeDefined();
    // Bare generated key → individual texture, no spritesheet frame.
    expect(shopTable?.frame).toBeUndefined();
    expect(desk?.frame).toBeUndefined();
    // Both resolved to real art: no labeled-placeholder rects were drawn.
    expect(propRects).toHaveLength(0);
    // Desk sits above the entity plane; the background prop stays below it.
    expect(shopTable?.depth).toBeLessThan(ENTITY_DEPTH);
    expect(desk?.depth).toBeGreaterThan(ENTITY_DEPTH);

    bridge.destroy();
    expect(shopTable?.destroyed).toBe(true);
    expect(desk?.destroyed).toBe(true);
  });

  it('uses procedural texture key when no Kenney sheet is loaded', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toMatch(/^__cw_/);
    expect(images[0]?.frame).toBeUndefined();
    expect(images[0]?.scaleX).toBe(1);
  });

  it('prefers Kenney sprite + frame when the sheet texture exists', () => {
    // Exclude the generated player art so this exercises the Kenney FALLBACK.
    // The `player` render kind now also pins generated art (the placeholder
    // walk sheet), which otherwise wins and hides this branch.
    const { scene, images } = createSceneStub({
      kenneyLoaded: true,
      textureExists: (key) => !key.startsWith('player-walk-placeholder'),
    });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('kenney-tiny-dungeon');
    expect(images[0]?.frame).toBe(96); // player → Tiny Dungeon knight (frame 96)
    expect(images[0]?.scaleX).toBeGreaterThan(1); // upscaled from 16x16
  });

  it('prefers the pinned generated player art over the Kenney sheet', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('player-walk-placeholder-v1-var-0');
    // 64px art at 0.72 => 46px drawn box == 5.75 ft, matching the NPC scale.
    expect(images[0]?.scaleX).toBeCloseTo(0.72, 5);
  });

  it('fades the skull marker out quickly while the corpse desaturates and fades', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 12, y: 34 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);
    expect(images).toHaveLength(1);

    // First dead frame: skull spawned at full alpha, corpse untouched.
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 3000 }));
    bridge.sync(world);

    expect(images).toHaveLength(2);
    const corpse = images[0]!;
    const skull = images[1]!;
    expect(skull).toMatchObject({
      x: 96,
      y: 254, // ftToPx(34) - DEAD_SKULL_Y_OFFSET, no rise yet
      textureKey: '__cw_dead_skull',
      destroyed: false,
    });
    expect(skull.alpha).toBeCloseTo(0.95);
    expect(corpse.alpha).toBe(1);
    expect(corpse.tint).toBe(0xffffff); // no desaturation yet
    // A dead enemy renders on the ground plane (below the player at default
    // depth 0) so the player is never buried under a fresh kill.
    expect(corpse.depth).toBe(WORLD_VFX_DEPTH.corpse);
    expect(corpse.depth).toBeLessThan(0);

    // Partway through the short skull window: skull dimmer and floating up.
    world.stores.deathTimer.remainingMs[eid] = 3000 - 450;
    bridge.sync(world);
    expect(skull.alpha).toBeLessThan(0.95);
    expect(skull.alpha).toBeGreaterThan(0);
    expect(skull.y).toBeLessThan(254); // risen upward
    expect(corpse.tinted).toBe(true);
    expect(corpse.tint).not.toBe(0xffffff); // draining toward grey

    // Past the skull window but well before corpse removal: skull gone, corpse
    // still fully present and now fully desaturated.
    world.stores.deathTimer.remainingMs[eid] = 3000 - 900;
    bridge.sync(world);
    expect(skull.alpha).toBe(0);
    expect(skull.visible).toBe(false);
    expect(corpse.alpha).toBe(1);

    // Late linger: corpse fading out.
    world.stores.deathTimer.remainingMs[eid] = 600;
    bridge.sync(world);
    expect(corpse.alpha).toBeLessThan(1);
    expect(corpse.alpha).toBeGreaterThan(0);

    removeEntity(world.ecs, eid);
    bridge.sync(world);

    expect(corpse.destroyed).toBe(true);
    expect(skull.destroyed).toBe(true);
  });

  it('clears leftover corpse tint and linger state when a dead enemy EID is recycled', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 12, y: 34 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    bridge.sync(world);

    // Kill it and advance so the corpse takes on a grey multiply-tint and the
    // visual captures its 3000ms linger duration.
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 3000 }));
    bridge.sync(world);
    world.stores.deathTimer.remainingMs[eid] = 1500;
    bridge.sync(world);

    const corpse = images[0]!;
    expect(corpse.tinted).toBe(true);
    expect(corpse.tint).not.toBe(0xffffff);

    // Free the EID and immediately reuse it for a fresh living enemy with NO
    // intervening sync, so the bridge reuses the same sprite (it never sees the
    // EID go idle, so the cleanup pass never recreates the visual).
    removeEntity(world.ecs, eid);
    const recycled = addEntity(world.ecs);
    expect(recycled).toBe(eid); // bitecs reuses the freed EID
    addComponent(world.ecs, recycled, set(Position, { x: 50, y: 60 }));
    addComponent(world.ecs, recycled, Enemy);
    addComponent(world.ecs, recycled, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    bridge.sync(world);

    // The same sprite object was reused (not destroyed/recreated) and its
    // leftover corpse styling is gone: full colour at full opacity, and the
    // corpse depth has been reset to the default entity plane so the recycled
    // living enemy renders above blood pools and other corpses again.
    expect(corpse.destroyed).toBe(false);
    expect(corpse.tinted).toBe(false);
    expect(corpse.tint).toBe(0xffffff);
    expect(corpse.alpha).toBe(1);
    expect(corpse.depth).toBe(ENTITY_DEPTH);

    // The stale linger was cleared too, so a shorter second death recalibrates
    // from full. With a stale 3000ms total, 1000ms remaining would read as a
    // two-thirds-elapsed corpse and tint grey + drop alpha on the first frame.
    addComponent(world.ecs, recycled, set(DeathTimer, { remainingMs: 1000 }));
    bridge.sync(world);
    expect(corpse.tint).toBe(0xffffff);
    expect(corpse.alpha).toBe(1);
  });

  it('uses dedicated generated textures for rat/slime spawners and does not apply placeholder red', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    const ratsNestSpawner = addEntity(world.ecs);
    addComponent(world.ecs, ratsNestSpawner, set(Position, { x: 10, y: 20 }));
    addComponent(world.ecs, ratsNestSpawner, Enemy);
    addComponent(world.ecs, ratsNestSpawner, Spawner);
    addComponent(world.ecs, ratsNestSpawner, set(Sprite, { textureId: 1, width: 0, height: 0 }));

    const bruteEid = addEntity(world.ecs);
    addComponent(world.ecs, bruteEid, set(Position, { x: 40, y: 45 }));
    addComponent(world.ecs, bruteEid, Enemy);
    addComponent(world.ecs, bruteEid, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    world.enemyAppearanceKeys.set(bruteEid, 'rat-brute');

    // A plain enemy (no Spawner, no special appearance key) sharing the same frame.
    const mobEid = addEntity(world.ecs);
    addComponent(world.ecs, mobEid, set(Position, { x: 55, y: 65 }));
    addComponent(world.ecs, mobEid, Enemy);
    addComponent(world.ecs, mobEid, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    const slimePoolSpawner = addEntity(world.ecs);
    addComponent(world.ecs, slimePoolSpawner, set(Position, { x: 20, y: 25 }));
    addComponent(world.ecs, slimePoolSpawner, Enemy);
    addComponent(world.ecs, slimePoolSpawner, Spawner);
    addComponent(world.ecs, slimePoolSpawner, set(Sprite, { textureId: 2, width: 0, height: 0 }));

    bridge.sync(world);

    const ratsNestImg = images[0]!;
    const bruteImg = images[1]!;
    const mobImg = images[2]!;
    const slimePoolImg = images[3]!;
    expect(ratsNestImg.textureKey).toBe('rat-nest-v2-var-3');
    expect(slimePoolImg.textureKey).toBe('slime-pool-v1-var-3');
    expect(ratsNestImg.tinted).toBe(false);
    expect(slimePoolImg.tinted).toBe(false);
    expect(ratsNestImg.tint).toBe(0xffffff);
    expect(slimePoolImg.tint).toBe(0xffffff);
    expect(bruteImg.tinted).toBe(true);
    expect(bruteImg.tint).toBe(RAT_BRUTE_TINT);
    expect(mobImg.tinted).toBe(false);
    expect(mobImg.tint).toBe(0xffffff);

    // Textures stay stable frame-to-frame while living.
    bridge.sync(world);
    expect(ratsNestImg.textureKey).toBe('rat-nest-v2-var-3');
    expect(slimePoolImg.textureKey).toBe('slime-pool-v1-var-3');

    // Corpse styling still wins once the spawner dies.
    addComponent(world.ecs, ratsNestSpawner, set(DeathTimer, { remainingMs: 3000 }));
    bridge.sync(world);
    world.stores.deathTimer.remainingMs[ratsNestSpawner] = 1500;
    bridge.sync(world);
    expect(ratsNestImg.tint).not.toBe(0xffffff); // draining toward grey
  });

  it('detonates a hit corpse into cropped sprite shards on a corpseExplode event', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    // A corpse: dead enemy still lingering, with an on-screen visual.
    addComponent(world.ecs, eid, set(Position, { x: 100, y: 120 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 16, height: 16 }));
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 500 }));
    bridge.sync(world);
    const baseline = images.length;

    // Emit the event the core damage path would emit when the corpse is struck.
    world.combatEvents.push({
      type: 'corpseExplode',
      x: 100,
      y: 120,
      amount: 20,
      targetType: 'enemy',
      timestamp: 0,
      targetEid: eid,
      bloodColor: 0xcc0000,
      spriteTextureId: 0,
      knockbackDirX: 0,
      knockbackDirY: 1,
    });
    bridge.sync(world);

    // A 3x3 cut yields 9 shard images, each cropped to one grid cell and
    // depth-sorted into the world VFX band.
    const shards = images.slice(baseline);
    expect(shards.length).toBeGreaterThanOrEqual(9);
    expect(shards.every((s) => s.cropped)).toBe(true);
    expect(shards.every((s) => s.depth > 0)).toBe(true);
    // The crop rectangles tile the 16x16 frame exactly.
    const area = shards.reduce((sum, s) => sum + s.cropRect!.w * s.cropRect!.h, 0);
    expect(area).toBe(16 * 16);
  });

  it('shatters a baby-slime corpse at its shrunken on-screen scale', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    // Floor1 sidecar so the renderer can read the 'slime-mini' archetype.
    world.floorScenario = {
      enemyArchetypes: new Map<number, string>(),
      objective: { bossBattles: new Map() },
    } as unknown as NonNullable<typeof world.floorScenario>;

    // A baby-slime corpse: shrunken Sprite.width + 'slime-mini' archetype, so it
    // renders at 0.65 of a full slime (1.95 ft / 3.0 ft, the real split scale) —
    // its base scale is larger than what the player actually sees.
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 60, y: 60 }));
    addComponent(world.ecs, eid, set(Velocity, { x: 2, y: 0 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 2, width: 1.95, height: 1.95 }));
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 500 }));
    world.floorScenario!.enemyArchetypes.set(eid, 'slime-mini');

    bridge.sync(world);
    const corpseImg = images[0]!;
    // NOTE: enemy facing (flipX) is exercised by the dedicated facing test below;
    // this test deliberately asserts only shard SCALE so it doesn't become brittle
    // to future facing-policy tweaks.
    const renderedScale = corpseImg.scaleX; // baseScale * 0.65, the on-screen size
    const baseline = images.length;

    world.combatEvents.push({
      type: 'corpseExplode',
      x: 60,
      y: 60,
      amount: 20,
      targetType: 'enemy',
      timestamp: 0,
      targetEid: eid,
      bloodColor: 0xcc0000,
      spriteTextureId: 2,
      knockbackDirX: 0,
      knockbackDirY: 1,
    });
    bridge.sync(world);

    // Shards are sized to the corpse's actual on-screen scale, not its (larger)
    // base scale — so a baby slime sprays baby-sized chunks.
    const shards = images.slice(baseline).filter((s) => s.cropped);
    expect(shards.length).toBeGreaterThanOrEqual(9);
    for (const s of shards) {
      expect(s.scaleX).toBeCloseTo(renderedScale, 5);
      expect(s.scaleX).toBeGreaterThan(0);
    }
  });

  it('renders rats and slimes with distinct enemy textures', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const rat = addEntity(world.ecs);
    const slime = addEntity(world.ecs);

    addComponent(world.ecs, rat, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, rat, Enemy);
    addComponent(world.ecs, rat, set(Sprite, { textureId: 1, width: 16, height: 16 }));

    addComponent(world.ecs, slime, set(Position, { x: 30, y: 10 }));
    addComponent(world.ecs, slime, Enemy);
    addComponent(world.ecs, slime, set(Sprite, { textureId: 2, width: 16, height: 16 }));

    bridge.sync(world);

    expect(images).toHaveLength(2);
    expect(images[0]?.textureKey).toBe('__cw_enemy_rat');
    expect(images[1]?.textureKey).toBe('__cw_enemy_slime');
  });

  it('uses the generated rat texture when its art is loaded', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const rat = addEntity(world.ecs);

    addComponent(world.ecs, rat, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, rat, Enemy);
    addComponent(world.ecs, rat, set(Sprite, { textureId: 1, width: 16, height: 16 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('rat-v1-var-9');
  });

  it('upgrades an existing slime visual to generated art once the texture becomes available', () => {
    const images: MockImage[] = [];
    let slimeGeneratedLoaded = false;
    const scene = {
      add: {
        image: vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
          const mockImage = new MockImage(x, y, textureKey, frame);
          images.push(mockImage);
          return mockImage as unknown as Phaser.GameObjects.Image;
        }),
      },
      textures: {
        exists: (key: string) =>
          key === 'kenney-tiny-dungeon' || (key === 'slime-v1-var-9' && slimeGeneratedLoaded),
      },
    } as unknown as Phaser.Scene;
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const slime = addEntity(world.ecs);

    addComponent(world.ecs, slime, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, slime, Enemy);
    addComponent(world.ecs, slime, set(Sprite, { textureId: 2, width: 3, height: 3 }));

    bridge.sync(world);
    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('kenney-tiny-dungeon');

    slimeGeneratedLoaded = true;
    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('slime-v1-var-9');
    expect(images[0]?.scaleX).toBeCloseTo(0.4, 6);
  });

  it('resolves slime generated texture from brief family when a new variant is checked in', () => {
    const images: MockImage[] = [];
    const available = new Set(['kenney-tiny-dungeon', 'slime-v1-var-42']);
    const scene = {
      add: {
        image: vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
          const mockImage = new MockImage(x, y, textureKey, frame);
          images.push(mockImage);
          return mockImage as unknown as Phaser.GameObjects.Image;
        }),
      },
      textures: {
        exists: (key: string) => available.has(key),
        getTextureKeys: () => Array.from(available),
      },
    } as unknown as Phaser.Scene;
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const slime = addEntity(world.ecs);

    addComponent(world.ecs, slime, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, slime, Enemy);
    addComponent(world.ecs, slime, set(Sprite, { textureId: 2, width: 3, height: 3 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('slime-v1-var-42');
    expect(images[0]?.scaleX).toBeCloseTo(0.4, 6);
  });

  it('uses the stored spawn-time roll to pick a loaded generated slime variant', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    (scene.game as unknown) = {
      registry: {
        get: () =>
          buildGeneratedSpriteRegistry({
            version: 1,
            entries: {
              'slime-v1-var-2': {
                briefId: 'slime-v1',
                spriteName: 'slime-v1-var-2',
                assetPath: 'generated/slime-v1-var-2.png',
                approvedAt: '2026-06-30T00:00:00.000Z',
                sourceRun: 'test',
                variantIndex: 2,
                anchor: null,
                sensorScore: '7/8',
                judgeScore: '2',
              },
              'slime-v1-var-9': {
                briefId: 'slime-v1',
                spriteName: 'slime-v1-var-9',
                assetPath: 'generated/slime-v1-var-9.png',
                approvedAt: '2026-06-30T00:00:00.000Z',
                sourceRun: 'test',
                variantIndex: 9,
                anchor: null,
                sensorScore: '7/8',
                judgeScore: '2',
              },
            },
          }),
      },
    };
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const slime = addEntity(world.ecs);

    addComponent(world.ecs, slime, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, slime, Enemy);
    addComponent(
      world.ecs,
      slime,
      set(Sprite, { textureId: 2, width: 16, height: 16, variantRoll: 0.99, sizeScale: 1 }),
    );

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('slime-v1-var-9');
  });

  it('uses distinct generated boss art for the staircase and slime-rat mid-boss', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const staircaseBoss = addEntity(world.ecs);
    const slimeRatBoss = addEntity(world.ecs);

    addComponent(world.ecs, staircaseBoss, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, staircaseBoss, Enemy);
    addComponent(world.ecs, staircaseBoss, set(Sprite, { textureId: 2, width: 4, height: 4 }));
    addComponent(world.ecs, slimeRatBoss, set(Position, { x: 30, y: 10 }));
    addComponent(world.ecs, slimeRatBoss, Enemy);
    addComponent(world.ecs, slimeRatBoss, set(Sprite, { textureId: 2, width: 4, height: 4 }));

    world.floorScenario = {
      enemyArchetypes: new Map<number, string>(),
      objective: {
        bossBattles: new Map([
          ['slime-rat', { bossEid: slimeRatBoss }],
          ['staircase', { bossEid: staircaseBoss }],
        ]),
      },
    } as unknown as NonNullable<typeof world.floorScenario>;

    bridge.sync(world);

    expect(images).toHaveLength(2);
    // Each boss resolves its own dedicated generated art via the bossBattles
    // key: 'staircase' → rat-slime-v1, 'slime-rat' (mid-boss) → slime-rat-boss.
    expect(images[0]?.textureKey).toBe('rat-slime-v1-var-1');
    expect(images[1]?.textureKey).toBe('slime-rat-boss-var-1');
  });

  it('renders the approved baseball-bat-v1 generated art on a bat swing once its texture is ready', () => {
    const { scene, images } = makeBatSwingScene(new Set(['baseball-bat-v1-var-0']));
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const owner = addEntity(world.ecs);
    spawnMeleeSwing(world, 10, 10, owner, 5, 3, 5_000, 1, 0, 90, 0, 0, 0, 1, 0, MeleeSpriteId.BAT);

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('baseball-bat-v1-var-0');
  });

  it('falls back to the Kenney weapon.bat sprite when the generated bat texture has not loaded', () => {
    const { scene, images } = makeBatSwingScene(new Set());
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const owner = addEntity(world.ecs);
    spawnMeleeSwing(world, 10, 10, owner, 5, 3, 5_000, 1, 0, 90, 0, 0, 0, 1, 0, MeleeSpriteId.BAT);

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('kenney-tiny-dungeon');
    // The bat's Kenney placeholder is frame 117 on the tiny-dungeon sheet.
    expect(images[0]?.frame.name).toBe(getSprite('weapon.bat')?.frame);
  });

  it('upgrades a bat swing to the generated art mid-swing and then stops re-applying the texture', () => {
    // Generated PNG not loaded yet — the fallback path is used.
    const readyKeys = new Set<string>();
    const { scene, images } = makeBatSwingScene(readyKeys);
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const owner = addEntity(world.ecs);
    spawnMeleeSwing(world, 10, 10, owner, 5, 3, 5_000, 1, 0, 90, 0, 0, 0, 1, 0, MeleeSpriteId.BAT);

    // Frame 1: generated texture missing -> Kenney fallback (frame 117).
    bridge.sync(world);
    expect(images).toHaveLength(1);
    const img = images[0]!;
    expect(img.textureKey).toBe('kenney-tiny-dungeon');
    expect(img.frame.name).toBe(getSprite('weapon.bat')?.frame);

    // Frame 2: still the stable fallback -> guard must not re-`setTexture`.
    bridge.sync(world);
    expect(img.setTextureCalls).toBe(0);

    // Frame 3: the generated PNG finishes loading -> upgrade with exactly one
    // setTexture (key changed: kenney sheet -> generated texture).
    readyKeys.add('baseball-bat-v1-var-0');
    bridge.sync(world);
    expect(img.textureKey).toBe('baseball-bat-v1-var-0');
    expect(img.setTextureCalls).toBe(1);

    // Frames 4-6: stable generated art. The pre-fix guard mis-fired here —
    // a loader.image texture's frame is named '__BASE' (never undefined), so
    // `'__BASE' !== undefined` stayed true and setTexture ran every sync.
    // The fixed guard only reconciles on a real key/frame change, so the
    // count stays pinned at 1.
    bridge.sync(world);
    bridge.sync(world);
    bridge.sync(world);
    expect(img.setTextureCalls).toBe(1);
  });

  it('renders mob health bars for non-boss enemies only', () => {
    const { scene, images, graphics } = createSceneStub({
      kenneyLoaded: false,
      withGraphics: true,
    });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const normalEnemy = addEntity(world.ecs);
    const bossEnemy = addEntity(world.ecs);

    addComponent(world.ecs, normalEnemy, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, normalEnemy, Enemy);
    addComponent(world.ecs, normalEnemy, set(Sprite, { textureId: 2, width: 3, height: 3 }));
    world.stores.health.current[normalEnemy] = 60;
    world.stores.health.max[normalEnemy] = 100;

    addComponent(world.ecs, bossEnemy, set(Position, { x: 30, y: 10 }));
    addComponent(world.ecs, bossEnemy, Enemy);
    addComponent(world.ecs, bossEnemy, set(Sprite, { textureId: 2, width: 4, height: 4 }));
    world.stores.health.current[bossEnemy] = 90;
    world.stores.health.max[bossEnemy] = 100;

    world.floorScenario = {
      enemyArchetypes: new Map<number, string>(),
      objective: {
        bossBattles: new Map([['slime-rat', { bossEid: bossEnemy }]]),
      },
    } as unknown as NonNullable<typeof world.floorScenario>;

    bridge.sync(world);

    expect(images).toHaveLength(2);
    expect(graphics).toHaveLength(1);
    const barGraphics = graphics[0]!;
    expect(barGraphics.fillRects.length).toBeGreaterThanOrEqual(2);
    const [shellRect, fillRect] = barGraphics.fillRects;
    expect(shellRect).toBeDefined();
    expect(fillRect).toBeDefined();

    // Geometry lock: the mob bar should stay close to the sprite and remain thin.
    // MockImage has no displayHeight, so PhaserBridge uses the 8px-half-height fallback.
    const enemyImg = images[0]!;
    expect(fillRect!.y).toBe(enemyImg.y + 8 + 2);
    expect(fillRect!.h).toBe(3);
    expect(shellRect!.h).toBe(5);
  });

  it('renders slime-mini babies smaller than a full slime', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    // Minimal floor1 sidecar so the renderer can read the 'slime-mini' archetype
    // and iterate boss battles (both accessed during enemy sync).
    world.floorScenario = {
      enemyArchetypes: new Map<number, string>(),
      objective: { bossBattles: new Map() },
    } as unknown as NonNullable<typeof world.floorScenario>;

    const fullSlime = addEntity(world.ecs);
    const miniSlime = addEntity(world.ecs);

    // Full slime: no archetype, so it renders at the base enemy scale. Width is
    // the real feet-based `spriteWidth` from enemies.floor1.json (3.0 ft).
    addComponent(world.ecs, fullSlime, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, fullSlime, Enemy);
    addComponent(world.ecs, fullSlime, set(Sprite, { textureId: 2, width: 3, height: 3 }));

    // Baby slime: shrunken Sprite.width + 'slime-mini' archetype, no SpawnAnim so
    // it renders at a steady, smaller size. The split sets width to 0.65 of the
    // parent (3.0 ft × 0.65 = 1.95 ft), so it must render at 0.65 of a full slime.
    addComponent(world.ecs, miniSlime, set(Position, { x: 30, y: 10 }));
    addComponent(world.ecs, miniSlime, Enemy);
    addComponent(world.ecs, miniSlime, set(Sprite, { textureId: 2, width: 1.95, height: 1.95 }));
    world.floorScenario!.enemyArchetypes.set(miniSlime, 'slime-mini');

    bridge.sync(world, 0);
    bridge.sync(world, 500);

    expect(images).toHaveLength(2);
    const fullImg = images[0]!;
    const miniImg = images[1]!;

    // Full slime is scaled uniformly at the base scale.
    expect(fullImg.scaleX).toBeCloseTo(fullImg.scaleY, 6);
    expect(fullImg.scaleX).toBeGreaterThan(0);

    // Baby renders smaller, at 0.65 of the full slime's scale (1.95 ft / 3.0 ft),
    // still uniform. A pixel/feet unit mismatch in SLIME_FULL_SPRITE_WIDTH would
    // clamp this to the 0.2 floor and make babies "incredibly small".
    expect(miniImg.scaleX).toBeLessThan(fullImg.scaleX);
    expect(miniImg.scaleX).toBeCloseTo(miniImg.scaleY, 6);
    expect(miniImg.scaleX).toBeCloseTo(fullImg.scaleX * 0.65, 5);
  });

  it('faces enemies left at rest and turns them to face right only while moving right', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const enemy = addEntity(world.ecs);

    addComponent(world.ecs, enemy, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, enemy, set(Velocity, { x: 0, y: 0 }));
    addComponent(world.ecs, enemy, Enemy);
    addComponent(world.ecs, enemy, set(Sprite, { textureId: 1, width: 2, height: 2 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    const enemyImg = images[0]!;
    // Generated enemy art is authored facing RIGHT, and flipX mirrors the texture,
    // so flipX=true renders LEFT-facing and flipX=false renders (native) RIGHT-facing.
    // scaleX magnitude is flip-independent, so it stays constant across every state.
    const baselineScaleX = enemyImg.scaleX;
    expect(baselineScaleX).toBeGreaterThan(0);
    expect(enemyImg.scaleY).toBeGreaterThan(0);
    // At rest the enemy faces left (mirrored).
    expect(enemyImg.flipX).toBe(true);

    // Sub-epsilon rightward jitter must not flip it to face right.
    world.stores.velocity.x[enemy] = 0.0005;
    bridge.sync(world);
    expect(enemyImg.scaleX).toBeCloseTo(baselineScaleX, 6);
    expect(enemyImg.scaleY).toBeGreaterThan(0);
    expect(enemyImg.flipX).toBe(true);

    // Exactly at the epsilon magnitude (vx = 0.001): Velocity is stored as
    // Float32, so 0.001 rounds to ~0.00100000004 on read — just ABOVE the f64
    // epsilon (0.001) — and the enemy DOES cross the threshold and unflips to
    // face right. (No Float32 value equals the f64 epsilon exactly, so `>` and
    // `>=` are equivalent here; this pins the effective threshold, so bumping the
    // epsilon or changing the store width would break this assertion.)
    world.stores.velocity.x[enemy] = 0.001;
    bridge.sync(world);
    expect(enemyImg.scaleX).toBeCloseTo(baselineScaleX, 6);
    expect(enemyImg.flipX).toBe(false);

    // Moving right past the epsilon: unflip to show the native right-facing art.
    world.stores.velocity.x[enemy] = 0.002;
    bridge.sync(world);
    expect(enemyImg.scaleX).toBeCloseTo(baselineScaleX, 6);
    expect(enemyImg.flipX).toBe(false);

    // Moving left: back to the mirrored, left-facing pose.
    world.stores.velocity.x[enemy] = -1.5;
    bridge.sync(world);
    expect(enemyImg.scaleX).toBeCloseTo(baselineScaleX, 6);
    expect(enemyImg.flipX).toBe(true);
  });

  it('mirrors contact motion offset and rotation for left-facing enemies', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const enemy = addEntity(world.ecs);

    addComponent(world.ecs, enemy, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, enemy, set(Velocity, { x: -1, y: 0 }));
    addComponent(world.ecs, enemy, Enemy);
    addComponent(world.ecs, enemy, set(Sprite, { textureId: 1, width: 2, height: 2 }));
    world.floorScenario = {
      enemyArchetypes: new Map([[enemy, 'rat']]),
      objective: { bossBattles: new Map() },
    } as unknown as NonNullable<typeof world.floorScenario>;
    bridge.sync(world, 0);
    world.combatEvents.push({
      type: 'hit',
      x: 10,
      y: 10,
      amount: 2,
      targetType: 'player',
      sourceEid: enemy,
      sourceRenderGeneration: world.entityRenderGeneration[enemy],
      delivery: 'contact',
      timestamp: 1_000,
    });

    bridge.sync(world, 1_000);

    const enemyImg = images[0]!;
    const expected = sampleContactAttackMotion(0);
    expect(enemyImg.flipX).toBe(true);
    expect(enemyImg.x).toBeCloseTo(ftToPx(10) - ftToPx(expected.offsetX));
    expect(enemyImg.rotation).toBeCloseTo(-expected.rotation);
  });

  it('ignores enemy flash overlays on the UI camera at creation time', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const uiIgnore = vi.fn();
    scene.cameras = {
      getCamera: vi.fn((name: string) =>
        name === 'ui' ? ({ ignore: uiIgnore } as unknown as Phaser.Cameras.Scene2D.Camera) : null,
      ),
    } as unknown as Phaser.Scene['cameras'];
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const enemy = addEntity(world.ecs);

    addComponent(world.ecs, enemy, set(Position, { x: 8, y: 8 }));
    addComponent(world.ecs, enemy, set(Velocity, { x: -1, y: 0 }));
    addComponent(world.ecs, enemy, Enemy);
    addComponent(world.ecs, enemy, set(Sprite, { textureId: 1, width: 2, height: 2 }));
    world.floorScenario = {
      enemyArchetypes: new Map([[enemy, 'rat']]),
      objective: { bossBattles: new Map() },
    } as unknown as NonNullable<typeof world.floorScenario>;

    bridge.sync(world, 0);
    world.combatEvents.push({
      type: 'hit',
      x: 8,
      y: 8,
      amount: 2,
      targetType: 'enemy',
      targetEid: enemy,
      targetRenderGeneration: world.entityRenderGeneration[enemy],
      delivery: 'projectile',
      timestamp: 500,
    });
    bridge.sync(world, 500);

    expect(images).toHaveLength(2);
    expect(uiIgnore).toHaveBeenCalled();
    expect(uiIgnore).toHaveBeenCalledWith(images[1]);
  });

  // A welcome sign is a Sprite+Position entity whose textureId is the welcome
  // board (SPRITE_TEX_WELCOME_SIGN === 3). Its Rotation.angle aims the arrow at
  // the door that leads onward; the renderer picks the baked board so the
  // "WELCOME" word never reads upside-down.
  it('points a right-hemisphere welcome sign along its angle with the base board', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    // cos(angle) >= 0: the arrow-right board already reads upright, so the
    // renderer keeps the base texture and rotates straight to `angle`.
    const angle = Math.PI / 6; // 30°, cos > 0
    addComponent(world.ecs, eid, set(Position, { x: 40, y: 50 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 3, width: 16, height: 16 }));
    addComponent(world.ecs, eid, set(Rotation, { angle }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('__cw_welcome_sign');
    expect(images[0]?.rotation).toBeCloseTo(angle, 6);
  });

  it('swaps a left-hemisphere welcome sign to the mirrored board, measured from −x', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    // cos(angle) < 0: aiming the arrow-right board here would flip "WELCOME"
    // upside-down, so the renderer swaps to the arrow-left board and measures
    // rotation from the −x reference (angle − π) to keep the word readable while
    // the arrow still points along `angle`.
    const angle = (3 * Math.PI) / 4; // 135°, cos < 0
    addComponent(world.ecs, eid, set(Position, { x: 40, y: 50 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 3, width: 16, height: 16 }));
    addComponent(world.ecs, eid, set(Rotation, { angle }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('__cw_welcome_sign_left');
    expect(images[0]?.rotation).toBeCloseTo(angle - Math.PI, 6);
  });

  it('flips a welcome sign between boards as it rotates across the vertical', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    const rightAngle = Math.PI / 4; // cos > 0 → base board
    addComponent(world.ecs, eid, set(Position, { x: 40, y: 50 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 3, width: 16, height: 16 }));
    addComponent(world.ecs, eid, set(Rotation, { angle: rightAngle }));

    bridge.sync(world);
    expect(images).toHaveLength(1);
    const sign = images[0]!;
    expect(sign.textureKey).toBe('__cw_welcome_sign');
    expect(sign.rotation).toBeCloseTo(rightAngle, 6);

    // Rotate past vertical into the left hemisphere: the SAME sprite swaps to the
    // mirrored board and re-references its rotation — no new image is created.
    const leftAngle = (3 * Math.PI) / 4; // cos < 0 → mirrored board
    world.stores.rotation.angle[eid] = leftAngle;
    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(sign.textureKey).toBe('__cw_welcome_sign_left');
    expect(sign.rotation).toBeCloseTo(leftAngle - Math.PI, 6);
  });

  it('hides enemies on tiles outside current FOV visibility', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const floorMap = createBridgeTestMap();
    world.floorMap = floorMap;
    floorMap.clearVisibility();
    // Enemy at tile (2,2); tileSizeFt=32. Set TL sub-tile of tile (2,2): hx=4, hy=4.
    floorMap.setVisible(4, 4);
    const enemyVisible = addEntity(world.ecs);
    const enemyHidden = addEntity(world.ecs);

    addComponent(world.ecs, enemyVisible, set(Position, { x: 2 * 32 + 16, y: 2 * 32 + 16 }));
    addComponent(world.ecs, enemyVisible, Enemy);
    addComponent(world.ecs, enemyVisible, set(Sprite, { textureId: 0, width: 16, height: 16 }));

    addComponent(world.ecs, enemyHidden, set(Position, { x: 8 * 32 + 16, y: 8 * 32 + 16 }));
    addComponent(world.ecs, enemyHidden, Enemy);
    addComponent(world.ecs, enemyHidden, set(Sprite, { textureId: 0, width: 16, height: 16 }));

    bridge.sync(world);

    expect(images).toHaveLength(2);
    expect(images[0]?.visible).toBe(true);
    expect(images[1]?.visible).toBe(false);
  });

  it('applies a sine-wave bob offset to XP gems each frame', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    // ECS position is in feet; the bridge renders at ftToPx() pixels (×8), so
    // (100, 200) ft maps to (800, 1600) px on screen.
    addComponent(world.ecs, eid, set(Position, { x: 100, y: 200 }));
    addComponent(world.ecs, eid, set(XpGem, { value: 5 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 8, height: 8 }));

    // First frame: gem image x sits exactly on the ftToPx-mapped position.
    bridge.sync(world, 0);
    expect(images).toHaveLength(1);
    expect(images[0]!.x).toBe(800);
    // The bob offset is ≤ 5 px, so y stays within [1595, 1605].
    expect(Math.abs(images[0]!.y - 1600)).toBeLessThanOrEqual(5);

    // Second frame at t=450: y should still be within ±5 px of the mapped
    // baseline but may differ from the first frame (sine advances over time).
    const yAtFrame1 = images[0]!.y;
    bridge.sync(world, 450);
    expect(Math.abs(images[0]!.y - 1600)).toBeLessThanOrEqual(5);
    // After 450 ms the sine phase has advanced enough that y should have changed.
    expect(images[0]!.y).not.toBeCloseTo(yAtFrame1, 2);
  });

  it('cleans up gem spawn-time and shadow state when a gem entity is removed', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 50, y: 80 }));
    addComponent(world.ecs, eid, set(XpGem, { value: 3 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 8, height: 8 }));

    bridge.sync(world, 0);
    expect(images).toHaveLength(1);
    expect(images[0]!.destroyed).toBe(false);

    // Remove the gem entity; the next sync should destroy the image and clean up
    // internal gem state so there's no memory leak.
    removeEntity(world.ecs, eid);
    bridge.sync(world, 100);
    expect(images[0]!.destroyed).toBe(true);
  });

  it('applies a sine-wave bob offset to gold coins each frame', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    // (60, 90) ft → (480, 720) px via ftToPx (×8).
    addComponent(world.ecs, eid, set(Position, { x: 60, y: 90 }));
    addComponent(world.ecs, eid, set(Gold, { value: 12 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 8, height: 8 }));

    // First frame: coin image x sits exactly on the ftToPx-mapped position.
    bridge.sync(world, 0);
    expect(images).toHaveLength(1);
    expect(images[0]!.x).toBe(480);
    // The coin bob offset is ≤ 4 px, so y stays within [716, 724].
    expect(Math.abs(images[0]!.y - 720)).toBeLessThanOrEqual(4);

    // Second frame at t=450: y still within ±4 px of the mapped baseline but
    // shifts as the sine phase advances.
    const yAtFrame1 = images[0]!.y;
    bridge.sync(world, 450);
    expect(Math.abs(images[0]!.y - 720)).toBeLessThanOrEqual(4);
    expect(images[0]!.y).not.toBeCloseTo(yAtFrame1, 2);
  });

  it('cleans up gold spawn-time and shadow state when a coin entity is removed', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 40, y: 70 }));
    addComponent(world.ecs, eid, set(Gold, { value: 7 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 8, height: 8 }));

    bridge.sync(world, 0);
    expect(images).toHaveLength(1);
    expect(images[0]!.destroyed).toBe(false);

    // Removing the coin should destroy the image and clean up the spawn-time map
    // even when no ground shadow exists (the stub scene has no add.ellipse).
    removeEntity(world.ecs, eid);
    bridge.sync(world, 100);
    expect(images[0]!.destroyed).toBe(true);
  });

  describe('harvestable node rendering', () => {
    // A harvestable node carries the Harvestable tag (→ 'harvestable' render kind),
    // a Position, and a Sprite whose stored `variantRoll` picks the art variant.
    // defIndex 0 === crimson-mushroom, which maps to brief `crimson-mushroom-v1`.
    function spawnNode(
      world: ReturnType<typeof createTestWorld>,
      xFt: number,
      yFt: number,
      defIndex: number,
    ): number {
      const node = addEntity(world.ecs);
      addComponent(world.ecs, node, set(Position, { x: xFt, y: yFt }));
      addComponent(
        world.ecs,
        node,
        set(Harvestable, { defIndex, durationMs: 3_000, progressMs: 0 }),
      );
      addComponent(
        world.ecs,
        node,
        set(Sprite, { textureId: 0, width: 16, height: 16, variantRoll: 0, sizeScale: 1 }),
      );
      return node;
    }

    function spawnCrimsonNode(
      world: ReturnType<typeof createTestWorld>,
      xFt: number,
      yFt: number,
    ): number {
      return spawnNode(world, xFt, yFt, 0);
    }

    function crimsonMushroomRegistry(): ReturnType<typeof buildGeneratedSpriteRegistry> {
      return buildGeneratedSpriteRegistry({
        version: 1,
        entries: {
          'crimson-mushroom-v1-var-3': {
            briefId: 'crimson-mushroom-v1',
            spriteName: 'crimson-mushroom-v1-var-3',
            assetPath: 'generated/crimson-mushroom-v1-var-3.png',
            approvedAt: '2026-07-01T00:00:00.000Z',
            sourceRun: 'test',
            variantIndex: 3,
            anchor: null,
            sensorScore: '8/8',
            judgeScore: '3',
          },
        },
      });
    }

    it('renders a harvestable node as its generated sprite Image when the art is wired and loaded', () => {
      const { scene, images, graphics } = createSceneStub({
        kenneyLoaded: true,
        withGraphics: true,
      });
      (scene.game as unknown) = { registry: { get: () => crimsonMushroomRegistry() } };
      const bridge = createPhaserBridge(scene);
      const world = createTestWorld();
      spawnCrimsonNode(world, 10, 10); // 10 ft → 80 px via ftToPx (×8).

      bridge.sync(world);

      // Sprite path: exactly one node Image using the resolved manifest key,
      // scaled + depth-sorted to sit on the floor just below the entity plane.
      expect(images).toHaveLength(1);
      expect(images[0]?.textureKey).toBe('crimson-mushroom-v1-var-3');
      expect(images[0]?.x).toBe(80);
      expect(images[0]?.y).toBe(80);
      expect(images[0]?.scaleX).toBe(0.4);
      expect(images[0]?.depth).toBe(ENTITY_DEPTH - 0.2);
      expect(images[0]?.originX).toBe(0.5);
      expect(images[0]?.originY).toBe(0.5);
      // With a real sprite and no harvest in progress, the procedural tinted
      // circle body is NOT drawn (no fillStyle with the node tint anywhere).
      expect(
        graphics.some((g) => g.fillCalls.some((c) => c.color === HARVESTABLE_DEFS[0]!.tint)),
      ).toBe(false);
    });

    it('falls back to the procedural tinted circle when no generated art is available (pre-wiring behavior)', () => {
      const { scene, images, graphics } = createSceneStub({
        kenneyLoaded: false,
        withGraphics: true,
      });
      // No generated-sprite registry on the game → the resolver returns null, so
      // the bridge draws the legacy circle. This pins the OLD behavior as the
      // safe fallback for any unwired/not-yet-loaded node.
      const bridge = createPhaserBridge(scene);
      const world = createTestWorld();
      spawnCrimsonNode(world, 10, 10);

      bridge.sync(world);

      // Fallback path: NO node Image; the tinted circle body is drawn instead
      // (crimson-mushroom tint 0xcc3333) on the node Graphics.
      expect(images).toHaveLength(0);
      expect(
        graphics.some((g) => g.fillCalls.some((c) => c.color === HARVESTABLE_DEFS[0]!.tint)),
      ).toBe(true);
    });

    it('mixes sprite + circle in one sync: wired node → Image, unwired node → circle fallback', () => {
      // Registry only has crimson-mushroom art, so a crimson node (defIndex 0)
      // is wired but an azure node (defIndex 1) is not. A single sync() pass must
      // route each independently — the wired node draws its Image and NO circle,
      // the unwired node draws its circle and NO Image. This pins the per-node
      // fallback contract (a partially-wired floor renders correctly).
      const { scene, images, graphics } = createSceneStub({
        kenneyLoaded: true,
        withGraphics: true,
      });
      (scene.game as unknown) = { registry: { get: () => crimsonMushroomRegistry() } };
      const bridge = createPhaserBridge(scene);
      const world = createTestWorld();
      spawnCrimsonNode(world, 10, 10); // wired → crimson-mushroom-v1 art exists.
      spawnNode(world, 20, 20, 1); // azure-mushroom → no art in registry → circle.

      bridge.sync(world);

      // Exactly one Image, for the wired crimson node only.
      expect(images).toHaveLength(1);
      expect(images[0]?.textureKey).toBe('crimson-mushroom-v1-var-3');

      // The unwired azure node drew its tinted circle (azure tint 0x3377cc)...
      expect(
        graphics.some((g) => g.fillCalls.some((c) => c.color === HARVESTABLE_DEFS[1]!.tint)),
        'unwired azure node should draw its procedural circle',
      ).toBe(true);
      // ...while the wired crimson node did NOT draw a circle (crimson tint absent).
      expect(
        graphics.some((g) => g.fillCalls.some((c) => c.color === HARVESTABLE_DEFS[0]!.tint)),
        'wired crimson node should render a sprite, not a circle',
      ).toBe(false);
    });
  });

  // Deterministic render-cue coverage for the locked-trajectory enemy
  // projectile telegraph (core/systems/enemyTelegraph.ts). The bridge reads
  // ONLY the locked `telegraphOrigin*`/`telegraphDir*` fields — never live
  // position — so this pins the "what the player sees IS what will fire"
  // contract at the render layer, satisfying the repo's "observe before
  // done" rule via a reproducible, CI-enforced check rather than an ad-hoc
  // manual screenshot.
  describe('enemy projectile telegraph render cue', () => {
    it('draws a locked-trajectory line + origin marker while an enemy is telegraphing, pinned to the LOCKED origin even after the shooter drifts', () => {
      const { scene, graphics } = createSceneStub({ withGraphics: true });
      const bridge = createPhaserBridge(scene);
      const world = createTestWorld();
      const eid = spawnBehaviorEnemy(world, 10, 10, 10, AI_TYPE.RANGED, 0, 20, 20);

      // Lock the telegraph aiming due east; origin is the enemy's current
      // (10, 10) position at lock time — this is what must render, even if
      // the enemy later drifts (knockback/jiggle never un-locks it).
      startEnemyProjectileTelegraph(world, eid, 1, 0);

      // Simulate knockback moving the shooter AFTER the origin locked — the
      // cue must still render at the ORIGINAL (10, 10) ft / (80, 80) px
      // origin, not the enemy's new live position, and along the originally
      // locked (1, 0) direction.
      world.stores.position.x[eid] = 40;
      world.stores.position.y[eid] = 60;

      bridge.sync(world);

      // The cue's red fillStyle (origin-marker circle) must appear on some
      // graphics object created this sync, and that object must be visible.
      const telegraphGfx = graphics.find((g) => g.fillCalls.some((c) => c.color === 0xff2222));
      expect(telegraphGfx).toBeDefined();
      expect(telegraphGfx?.visible).toBe(true);

      // Pin the actual drawn coordinates: moveTo/fillCircle must sit at the
      // LOCKED origin (10ft → 80px), not the drifted live position
      // (40ft/60ft → 320px/480px), and lineTo must extend east from there —
      // proving the cue tracks the locked trajectory, not the live entity.
      expect(telegraphGfx?.moveToCalls).toContainEqual({ x: 80, y: 80 });
      expect(telegraphGfx?.fillCircleCalls).toContainEqual({ x: 80, y: 80, r: 4 });
      const lineTo = telegraphGfx?.lineToCalls[telegraphGfx.lineToCalls.length - 1];
      expect(lineTo).toBeDefined();
      expect(lineTo?.y).toBeCloseTo(80, 5);
      expect(lineTo?.x).toBeGreaterThan(80);
    });

    it('hides (but does not recreate) the telegraph graphic once telegraphActive clears', () => {
      const { scene, graphics } = createSceneStub({ withGraphics: true });
      const bridge = createPhaserBridge(scene);
      const world = createTestWorld();
      const eid = spawnBehaviorEnemy(world, 10, 10, 10, AI_TYPE.RANGED, 0, 20, 20);
      startEnemyProjectileTelegraph(world, eid, 1, 0);

      bridge.sync(world);
      const countAfterFirstSync = graphics.length;
      const telegraphGfx = graphics.find((g) => g.fillCalls.some((c) => c.color === 0xff2222));
      expect(telegraphGfx?.visible).toBe(true);

      // Simulate the telegraph resolving (shot fired) or being cancelled —
      // either way `telegraphActive` clears without the entity being removed.
      world.stores.enemyBehavior.telegraphActive[eid] = 0;
      bridge.sync(world);

      // Same graphics object, now hidden — no new telegraph graphics created.
      expect(graphics.length).toBe(countAfterFirstSync);
      expect(telegraphGfx?.visible).toBe(false);
    });

    it('does not draw the cue for a telegraphing enemy hidden outside current FOV visibility', () => {
      const { scene, graphics } = createSceneStub({ withGraphics: true });
      const bridge = createPhaserBridge(scene);
      const world = createTestWorld();
      const floorMap = createBridgeTestMap();
      world.floorMap = floorMap;
      floorMap.clearVisibility();
      // Leave every tile dark — the shooter below sits at tile (8,8), which
      // stays unlit, so it must be treated exactly like the sprite/health-bar
      // FOV gate: never reveal position or aim line while hidden.
      const eid = spawnBehaviorEnemy(
        world,
        8 * 32 + 16,
        8 * 32 + 16,
        10,
        AI_TYPE.RANGED,
        0,
        20,
        20,
      );
      startEnemyProjectileTelegraph(world, eid, 1, 0);

      bridge.sync(world);

      const telegraphGfx = graphics.find((g) => g.fillCalls.some((c) => c.color === 0xff2222));
      expect(telegraphGfx).toBeUndefined();
    });

    it('does not draw the cue for a shooter killed this same frame, matching the health-bar dead-enemy gate', () => {
      // Damage/drop/death processing runs after enemy AI, and this render
      // pass runs after that — so a shooter killed earlier this frame can
      // still have `telegraphActive` set until the NEXT enemyAISystem pass
      // cancels it. Without gating on `!isDeadEnemy` the cue would draw from
      // a corpse (indefinitely, if simulation ever paused on this frame).
      const { scene, graphics } = createSceneStub({ withGraphics: true });
      const bridge = createPhaserBridge(scene);
      const world = createTestWorld();
      const eid = spawnBehaviorEnemy(world, 10, 10, 10, AI_TYPE.RANGED, 0, 20, 20);
      startEnemyProjectileTelegraph(world, eid, 1, 0);
      addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 3000 }));

      bridge.sync(world);

      const telegraphGfx = graphics.find((g) => g.fillCalls.some((c) => c.color === 0xff2222));
      expect(telegraphGfx).toBeUndefined();
    });

    it('destroys a stale telegraph graphic if its EID stops resolving as an enemy (recycled mid-simulation)', () => {
      // Multiple fixed-step simulation ticks can run between renders (e.g.
      // while catching up / fast-forwarding), so bitecs can recycle a
      // removed enemy's EID for an unrelated entity before the next
      // bridge.sync(). `activeEntities.has(eid)` alone can't tell "same
      // enemy" apart from "different entity now at this recycled EID" — the
      // cleanup pass must also require the EID to still resolve as 'enemy',
      // or the old aim line would keep rendering pinned to the wrong entity.
      const { scene, graphics } = createSceneStub({ withGraphics: true });
      const bridge = createPhaserBridge(scene);
      const world = createTestWorld();
      const eid = spawnBehaviorEnemy(world, 10, 10, 10, AI_TYPE.RANGED, 0, 20, 20);
      startEnemyProjectileTelegraph(world, eid, 1, 0);

      bridge.sync(world);
      const telegraphGfx = graphics.find((g) => g.fillCalls.some((c) => c.color === 0xff2222));
      expect(telegraphGfx).toBeDefined();
      expect(telegraphGfx?.destroyed).toBe(false);

      // Simulate the EID being recycled for a non-enemy entity: strip the
      // `Enemy` tag while leaving Sprite/Position in place, so the eid
      // still satisfies the render query (stays in `activeEntities`) but no
      // longer resolves as an enemy.
      removeComponent(world.ecs, eid, Enemy);

      bridge.sync(world);

      expect(telegraphGfx?.destroyed).toBe(true);
    });

    it("phases the urgency pulse on the telegraph's own elapsed time, not the absolute render clock (regression: copilot-pull-request-reviewer finding)", () => {
      // The pulse's sine phase must depend only on how long THIS telegraph
      // has been active (elapsedMs = renderElapsedMs - telegraphStartMs), not
      // on the absolute `renderElapsedMs` the game has been running for.
      // Because the pulse FREQUENCY also depends on `progress` (time-since-
      // start / delay), phasing on the absolute clock makes the sine phase
      // jump by an amount proportional to total run time — after the game
      // has run a while, tiny per-frame progress changes would produce
      // effectively random high-frequency flicker instead of a smooth
      // urgency ramp. Prove this can't happen: two telegraphs at the same
      // RELATIVE elapsed-since-start-of-telegraph time, but wildly different
      // ABSOLUTE render clock values, must produce an identical stroke alpha.
      const relativeElapsedMs = 5000;

      const early = createSceneStub({ withGraphics: true });
      const earlyBridge = createPhaserBridge(early.scene);
      const earlyWorld = createTestWorld();
      earlyWorld.elapsedMs = 0;
      const earlyEid = spawnBehaviorEnemy(earlyWorld, 10, 10, 10, AI_TYPE.RANGED, 0, 20, 20);
      startEnemyProjectileTelegraph(earlyWorld, earlyEid, 1, 0);
      earlyBridge.sync(earlyWorld, relativeElapsedMs);
      const earlyGfx = early.graphics.find((g) => g.fillCalls.some((c) => c.color === 0xff2222));
      const earlyLine = earlyGfx?.lineStyleCalls.find((c) => c.color === 0xff2222);

      const late = createSceneStub({ withGraphics: true });
      const lateBridge = createPhaserBridge(late.scene);
      const lateWorld = createTestWorld();
      lateWorld.elapsedMs = 1_000_000; // long-running game session
      const lateEid = spawnBehaviorEnemy(lateWorld, 10, 10, 10, AI_TYPE.RANGED, 0, 20, 20);
      startEnemyProjectileTelegraph(lateWorld, lateEid, 1, 0);
      lateBridge.sync(lateWorld, 1_000_000 + relativeElapsedMs);
      const lateGfx = late.graphics.find((g) => g.fillCalls.some((c) => c.color === 0xff2222));
      const lateLine = lateGfx?.lineStyleCalls.find((c) => c.color === 0xff2222);

      expect(earlyLine).toBeDefined();
      expect(lateLine).toBeDefined();
      expect(lateLine?.alpha).toBeCloseTo(earlyLine!.alpha, 10);
    });

    it('renders the cue for one frame via the sticky flag when the telegraph completes within a batch (16× AI-runner lab scenario)', () => {
      // Reproduces the 16× catch-up-loop scenario: multiple sim steps run
      // between renders, so a short telegraph (e.g. 250ms default) can start
      // AND fire entirely within one batch — `telegraphActive` is 0 by the
      // time sync() is called, but `telegraphWasActiveThisFrame` remains 1
      // so the cue is still visible for exactly one rendered frame.
      const { scene, graphics } = createSceneStub({ withGraphics: true });
      const bridge = createPhaserBridge(scene);
      const world = createTestWorld();
      const eid = spawnBehaviorEnemy(world, 10, 10, 10, AI_TYPE.RANGED, 0, 20, 20);

      // Step 1 of the simulated batch: telegraph begins.
      startEnemyProjectileTelegraph(world, eid, 1, 0);
      // telegraphWasActiveThisFrame must be set immediately by startEnemyProjectileTelegraph.
      expect(world.stores.enemyBehavior.telegraphWasActiveThisFrame[eid]).toBe(1);

      // Step N of the same batch: telegraph fires — active clears to 0.
      // (In the real game cancelEnemyProjectileTelegraph / fire code does this.)
      world.stores.enemyBehavior.telegraphActive[eid] = 0;

      // At this point `telegraphActive = 0` but `wasActiveThisFrame = 1`.
      // sync() must render the cue for one frame via the sticky flag.
      bridge.sync(world);

      const telegraphGfx = graphics.find((g) => g.fillCalls.some((c) => c.color === 0xff2222));
      expect(telegraphGfx).toBeDefined();
      expect(telegraphGfx?.visible).toBe(true);

      // After sync() the sticky flag must be cleared, so the NEXT sync does
      // NOT render the cue (both flags are 0).
      expect(world.stores.enemyBehavior.telegraphWasActiveThisFrame[eid]).toBe(0);

      const countAfterFirstSync = graphics.length;
      bridge.sync(world);

      // No new cue graphics created; existing one now hidden.
      expect(graphics.length).toBe(countAfterFirstSync);
      expect(telegraphGfx?.visible).toBe(false);
    });
  });
});
