/**
 * HARD SUCCESS GATE for Slice A (engine animation layer + player walk cycle):
 * a deterministic, headless test asserting the player sprite's active
 * animation frame index advances while the player is moving, and holds
 * constant while the player is stationary.
 *
 * This exercises the REAL production path end-to-end:
 *   - `buildGeneratedSpriteRegistry` (shared schema) parses a manifest entry
 *     carrying an `animation` descriptor for the player's generated texture.
 *   - `createPhaserBridge(scene).sync(world)` (the real bridge) resolves the
 *     player's pinned generated texture, discovers its `animation` descriptor,
 *     creates a `scene.add.sprite` (not a plain `Image`), registers the walk
 *     animation via `registerGeneratedSpriteAnimations`, and calls
 *     `anims.play()` / `anims.stop()` based on the player's velocity.
 *
 * There is no real WebGL/game-loop in this environment, so
 * `MockAnimationState.tick(deltaMs)` (see `tests/fixtures/phaser-bridge-harness.ts`)
 * stands in for Phaser's per-frame `AnimationState.update`, advancing
 * `currentFrame.index` against the SAME frameRate/frameCount the bridge
 * registered — deterministic, no LLM judge, no manual eyeballing.
 */
import { addComponent, addEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Player, Position, Sprite, Velocity } from '../../src/core/components.js';
import { set } from '../../src/core/world.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createSceneStub } from '../fixtures/phaser-bridge-harness.js';

/** Matches the real `player-walk-cycle-female` manifest entry's shape (default gender). */
const PLAYER_WALK_TEXTURE_KEY = 'player-walk-cycle-female';

function buildTestRegistry() {
  return buildGeneratedSpriteRegistry({
    version: 1,
    entries: {
      [PLAYER_WALK_TEXTURE_KEY]: {
        briefId: PLAYER_WALK_TEXTURE_KEY,
        spriteName: PLAYER_WALK_TEXTURE_KEY,
        assetPath: `generated/${PLAYER_WALK_TEXTURE_KEY}.png`,
        approvedAt: '2026-01-01T00:00:00.000Z',
        sourceRun: 'test-fixture',
        variantIndex: 0,
        anchor: null,
        sensorScore: 'n/a',
        judgeScore: null,
        animation: {
          frameWidth: 64,
          frameHeight: 64,
          frameCount: 3,
          frameRate: 6,
          loop: true,
        },
      },
    },
  });
}

function buildTestRegistryWithLoop(loop: boolean) {
  return buildGeneratedSpriteRegistry({
    version: 1,
    entries: {
      [PLAYER_WALK_TEXTURE_KEY]: {
        briefId: PLAYER_WALK_TEXTURE_KEY,
        spriteName: PLAYER_WALK_TEXTURE_KEY,
        assetPath: `generated/${PLAYER_WALK_TEXTURE_KEY}.png`,
        approvedAt: '2026-01-01T00:00:00.000Z',
        sourceRun: 'test-fixture',
        variantIndex: 0,
        anchor: null,
        sensorScore: 'n/a',
        judgeScore: null,
        animation: {
          frameWidth: 64,
          frameHeight: 64,
          frameCount: 3,
          frameRate: 6,
          loop,
        },
      },
    },
  });
}

/** Drives one bridge render tick, then advances the mock animation clock. */
function stepFrame(
  bridge: ReturnType<typeof createPhaserBridge>,
  world: ReturnType<typeof createTestWorld>,
  sprites: { anims: { tick(deltaMs: number): void } }[],
  deltaMs: number,
): void {
  bridge.sync(world);
  for (const sprite of sprites) {
    sprite.anims.tick(deltaMs);
  }
}

describe('player walk-cycle animation (hard success gate)', () => {
  it('advances the active frame index while moving and holds it while stationary', () => {
    const generatedRegistry = buildTestRegistry();
    const { scene, sprites } = createSceneStub({ generatedRegistry });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    addComponent(world.ecs, eid, set(Velocity, { x: 3, y: 0 }));

    // First sync creates the sprite and starts the walk animation.
    bridge.sync(world);
    expect(sprites).toHaveLength(1);
    const player = sprites[0]!;
    expect(player.textureKey).toBe(PLAYER_WALK_TEXTURE_KEY);
    expect(player.anims.isPlaying).toBe(true);
    // Moving right with the default (right-facing) texture must not mirror.
    expect(player.flipX).toBe(false);

    const framesSeenWhileMoving: number[] = [player.anims.currentFrame.index];
    for (let i = 0; i < 6; i += 1) {
      // ~1/6s per step at frameRate=6 => exactly one frame advance per step.
      stepFrame(bridge, world, sprites, 1000 / 6);
      framesSeenWhileMoving.push(player.anims.currentFrame.index);
    }

    // The frame index must have changed at least once while moving — the
    // core assertion of the hard gate.
    const distinctFramesWhileMoving = new Set(framesSeenWhileMoving);
    expect(distinctFramesWhileMoving.size).toBeGreaterThan(1);
    // And it must actually cycle through more than just two values given a
    // 3-frame, looping animation observed over 6 ticks.
    expect(distinctFramesWhileMoving.size).toBe(3);

    // Now stop the player and confirm the frame index freezes.
    addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
    bridge.sync(world);
    expect(player.anims.isPlaying).toBe(false);
    // Stopping (vx === 0) must NOT re-derive facing — the player should keep
    // facing right (its last horizontal direction), not snap to mirrored.
    expect(player.flipX).toBe(false);
    const frozenFrame = player.anims.currentFrame.index;

    for (let i = 0; i < 6; i += 1) {
      stepFrame(bridge, world, sprites, 1000 / 6);
      expect(player.anims.currentFrame.index).toBe(frozenFrame);
    }

    // Stopping mid-stride must snap the DISPLAYED sprite frame back to 0 —
    // the walk sheet's designated idle pose — not freeze on whatever
    // mid-cycle frame the loop happened to be on (contract documented on
    // `GeneratedSpriteEntry['animation']` in `src/shared/generated-assets.ts`).
    expect(player.frame).toBe(0);
  });

  it('does not create a Sprite/animation for textures without an animation descriptor', () => {
    // No generatedRegistry => scene.anims/add.sprite are both unavailable,
    // mirroring every pre-existing test scene stub and today's static-frame
    // entries (e.g. the original `rhea-vale-var-0` portrait).
    const { scene, images, sprites } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    addComponent(world.ecs, eid, set(Velocity, { x: 3, y: 0 }));

    bridge.sync(world);

    expect(sprites).toHaveLength(0);
    expect(images).toHaveLength(1);
  });

  it('preserves horizontal facing when moving vertically or at rest, and mirrors when moving left', () => {
    const generatedRegistry = buildTestRegistry();
    const { scene, sprites } = createSceneStub({ generatedRegistry });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    // Move left first — should mirror.
    addComponent(world.ecs, eid, set(Velocity, { x: -3, y: 0 }));
    bridge.sync(world);
    const player = sprites[0]!;
    expect(player.flipX).toBe(true);

    // Now walk straight up (vx === 0) — facing must be preserved (still mirrored).
    addComponent(world.ecs, eid, set(Velocity, { x: 0, y: -3 }));
    bridge.sync(world);
    expect(player.anims.isPlaying).toBe(true);
    expect(player.flipX).toBe(true);

    // Come to a full stop — facing must still be preserved.
    addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
    bridge.sync(world);
    expect(player.anims.isPlaying).toBe(false);
    expect(player.flipX).toBe(true);

    // Finally move right — should un-mirror.
    addComponent(world.ecs, eid, set(Velocity, { x: 3, y: 0 }));
    bridge.sync(world);
    expect(player.flipX).toBe(false);
  });

  it('plays non-looping walk strips once per movement episode', () => {
    const generatedRegistry = buildTestRegistryWithLoop(false);
    const { scene, sprites } = createSceneStub({ generatedRegistry });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    addComponent(world.ecs, eid, set(Velocity, { x: 3, y: 0 }));

    bridge.sync(world);
    const player = sprites[0]!;
    expect(player.anims.isPlaying).toBe(true);

    for (let i = 0; i < 8; i += 1) {
      stepFrame(bridge, world, sprites, 1000 / 6);
    }
    expect(player.anims.isPlaying).toBe(false);
    expect(player.anims.currentFrame.index).toBe(2);

    for (let i = 0; i < 4; i += 1) {
      stepFrame(bridge, world, sprites, 1000 / 6);
      expect(player.anims.isPlaying).toBe(false);
      expect(player.anims.currentFrame.index).toBe(2);
    }

    addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
    bridge.sync(world);
    expect(player.frame).toBe(0);

    addComponent(world.ecs, eid, set(Velocity, { x: 3, y: 0 }));
    bridge.sync(world);
    expect(player.anims.isPlaying).toBe(true);
  });

  it('regression: retries and eventually plays the walk animation when the texture is not loaded on the first sync (e.g. right after a scene restart)', () => {
    // Reproduces the real crash root cause: right after `phaserScene.scene.restart()`,
    // `PhaserBridge`'s first `sync()` can run before the generated-sprite
    // texture has finished loading into the `TextureManager`. Real Phaser's
    // `AnimationManager#generateFrameNumbers` returns `[]` (not a throw) for
    // an unregistered texture key, and the OLD code unconditionally created
    // an `Animation` from that empty list — permanently caching a
    // zero-frame animation under the key (since `anims.exists` never
    // resets), which crashed on the first `.play()` with
    // "Cannot read properties of undefined (reading 'duration')" inside
    // Phaser's `Animation#getFirstTick`, freezing the entire render loop.
    // The fix must skip creating on an empty frame array and retry on a
    // later `sync()` call within the SAME scene lifetime (no restart)
    // until the texture becomes available — this is exactly what a scene
    // restart needs, since `registerGeneratedSpriteAnimations` only runs
    // once per registry identity.
    const generatedRegistry = buildTestRegistry();
    const { scene, sprites, animationManager } = createSceneStub({ generatedRegistry });
    expect(animationManager).not.toBeNull();
    animationManager!.markTextureNotReady(PLAYER_WALK_TEXTURE_KEY);

    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    addComponent(world.ecs, eid, set(Velocity, { x: 3, y: 0 }));

    // First sync: texture not ready yet. Must not crash, must not register
    // a broken animation, and playing must simply no-op (never started).
    expect(() => bridge.sync(world)).not.toThrow();
    const player = sprites[0]!;
    expect(animationManager!.exists(`${PLAYER_WALK_TEXTURE_KEY}:walk`)).toBe(false);
    expect(player.anims.isPlaying).toBe(false);

    // A few more syncs while still not ready: still no crash, still no
    // broken registration — proves this isn't a one-shot lucky pass.
    for (let i = 0; i < 3; i += 1) {
      expect(() => bridge.sync(world)).not.toThrow();
    }
    expect(animationManager!.exists(`${PLAYER_WALK_TEXTURE_KEY}:walk`)).toBe(false);

    // Texture finishes loading — the NEXT sync (same scene, no restart)
    // must retry and succeed.
    animationManager!.markTextureReady(PLAYER_WALK_TEXTURE_KEY);
    expect(() => bridge.sync(world)).not.toThrow();
    expect(animationManager!.exists(`${PLAYER_WALK_TEXTURE_KEY}:walk`)).toBe(true);
    expect(player.anims.isPlaying).toBe(true);

    // Confirm it's a genuinely working animation, not just "registered":
    // the frame index must actually advance under ticks.
    const seenFrames = new Set<number>([player.anims.currentFrame.index]);
    for (let i = 0; i < 6; i += 1) {
      stepFrame(bridge, world, sprites, 1000 / 6);
      seenFrames.add(player.anims.currentFrame.index);
    }
    expect(seenFrames.size).toBeGreaterThan(1);
  });
});
