/**
 * PhaserBridge wiring for the enemy status-effect indicator (issue #3690).
 *
 * The bridge owns the gating (living, visible enemy) and feeds resolved aura
 * targets to `StatusEffectVfx`; these tests pin that contract, including the
 * FOV gate that stops an aura betraying a fog-hidden enemy.
 */
import { addComponent, addEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { DeathTimer, Enemy, Position, Sprite } from '../../src/core/components.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { _STATUS_AURA_LAYER_NAME } from '../../src/engine/StatusEffectVfx.js';
import { applyStatusEffect } from '../../src/core/status-effects.js';
import { set } from '../../src/core/world.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  createBridgeTestMap,
  createSceneStub,
  MockGraphics,
} from '../fixtures/phaser-bridge-harness.js';

/** Tile (2,2) is revealed by `revealOnlyFirstTile`; tile (8,8) is not. */
const VISIBLE_POSITION = { x: 2 * 32 + 16, y: 2 * 32 + 16 };
const HIDDEN_POSITION = { x: 8 * 32 + 16, y: 8 * 32 + 16 };

function addEnemy(world: GameWorld, position: { x: number; y: number }): number {
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(Position, position));
  addComponent(world.ecs, eid, Enemy);
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 16, height: 16 }));
  return eid;
}

function slow(world: GameWorld, eid: number, durationMs = 1_000): void {
  applyStatusEffect(world, eid, {
    stat: 'speed',
    op: 'multiply',
    value: 0.4,
    durationMs,
    sourceType: 'ability',
    sourceId: 'curse:active:0',
    stackRule: { mode: 'replace' },
  });
}

function auraGraphics(graphics: MockGraphics[]): MockGraphics | undefined {
  return graphics.find((gfx) => gfx.name === _STATUS_AURA_LAYER_NAME);
}

function createWorldWithRevealedTile(): GameWorld {
  const world = createTestWorld();
  const floorMap = createBridgeTestMap();
  world.floorMap = floorMap;
  floorMap.clearVisibility();
  // Sub-tile (4,4) lights tile (2,2) only — see the FOV characterization test.
  floorMap.setVisible(4, 4);
  return world;
}

describe('PhaserBridge status-effect indicator', () => {
  it('tints a status-affected enemy and draws its ground aura', () => {
    const { scene, images, graphics } = createSceneStub({ withGraphics: true });
    const bridge = createPhaserBridge(scene);
    const world = createWorldWithRevealedTile();
    const eid = addEnemy(world, VISIBLE_POSITION);
    slow(world, eid);

    bridge.sync(world, 0);

    expect(images[0]!.tinted).toBe(true);
    expect(images[0]!.tint).toBe(0xaadfff);
    const aura = auraGraphics(graphics);
    expect(aura?.fillEllipses).toHaveLength(1);
    expect(aura?.fillCalls[0]?.color).toBe(0x7dd3fc);
    // Drawn at the enemy's feet, i.e. below its sprite centre.
    expect(aura!.fillEllipses[0]!.y).toBeGreaterThan(images[0]!.y);
  });

  it('draws no aura for an enemy with no status effects', () => {
    const { scene, graphics } = createSceneStub({ withGraphics: true });
    const bridge = createPhaserBridge(scene);
    const world = createWorldWithRevealedTile();
    addEnemy(world, VISIBLE_POSITION);

    bridge.sync(world, 0);

    expect(auraGraphics(graphics)).toBeUndefined();
  });

  it('does not reveal a fog-hidden enemy through its aura', () => {
    const { scene, graphics } = createSceneStub({ withGraphics: true });
    const bridge = createPhaserBridge(scene);
    const world = createWorldWithRevealedTile();
    const hidden = addEnemy(world, HIDDEN_POSITION);
    slow(world, hidden);

    bridge.sync(world, 0);

    expect(auraGraphics(graphics)?.fillEllipses ?? []).toHaveLength(0);
  });

  it('drops the aura once the effect is gone', () => {
    const { scene, graphics } = createSceneStub({ withGraphics: true });
    const bridge = createPhaserBridge(scene);
    const world = createWorldWithRevealedTile();
    const eid = addEnemy(world, VISIBLE_POSITION);
    slow(world, eid);

    bridge.sync(world, 0);
    expect(auraGraphics(graphics)?.fillEllipses).toHaveLength(1);

    world.statusEffectsByEntity.delete(eid);
    bridge.sync(world, 16);

    const aura = auraGraphics(graphics)!;
    expect(aura.fillEllipses).toHaveLength(0);
    expect(aura.visible).toBe(false);
  });

  it('never paints a corpse', () => {
    const { scene, graphics } = createSceneStub({ withGraphics: true });
    const bridge = createPhaserBridge(scene);
    const world = createWorldWithRevealedTile();
    const eid = addEnemy(world, VISIBLE_POSITION);
    slow(world, eid);
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 500, totalMs: 500 }));

    bridge.sync(world, 0);

    expect(auraGraphics(graphics)?.fillEllipses ?? []).toHaveLength(0);
  });
});
