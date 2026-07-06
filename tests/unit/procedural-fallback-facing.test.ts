import { describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import { generateTextures } from '../../src/engine/phaser-bridge/textures.js';

/**
 * Regression guards for the LEFT-facing procedural fallback textures bug.
 *
 * The engine-wide sprite pipeline authors enemy art facing RIGHT
 * (`data/sprite-types/enemy.json` sets `sensors.enemy.facing: "right"`) and
 * `PhaserBridge` mirrors the texture via `flipX(!movingRight)` on the
 * assumption that the unflipped texture already faces right. The procedural
 * fallback rat + boss used to draw the head on the LEFT half — so whenever
 * the game fell back to procedural art (missing generated PNG, test scene
 * without the sprite pipeline, etc.), every enemy would face the opposite
 * direction of its motion. These tests bake the fallback textures on a
 * capture-only stub and assert the head-side detail sits in the RIGHT half of
 * the canvas.
 */

interface DrawCommand {
  op: string;
  x: number;
  y: number;
  r?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  x3?: number;
  y3?: number;
}

interface TextureBake {
  key: string;
  width: number;
  height: number;
  commands: DrawCommand[];
}

function createTextureRecordingScene(): { scene: Phaser.Scene; bakes: TextureBake[] } {
  const bakes: TextureBake[] = [];
  // Buffer of draw commands issued between generateTexture() calls. When
  // generateTexture(key, w, h) is called, the buffered commands are frozen
  // into a bake attributed to that key.
  let pending: DrawCommand[] = [];
  const graphics = {
    clear: vi.fn(() => {
      pending = [];
      return graphics;
    }),
    fillStyle: vi.fn(() => graphics),
    lineStyle: vi.fn(() => graphics),
    beginPath: vi.fn(() => graphics),
    strokePath: vi.fn(() => graphics),
    fillCircle: vi.fn((x: number, y: number, r: number) => {
      pending.push({ op: 'fillCircle', x, y, r });
      return graphics;
    }),
    fillEllipse: vi.fn((x: number, y: number, w: number, h: number) => {
      pending.push({ op: 'fillEllipse', x, y, x1: w, y1: h });
      return graphics;
    }),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      pending.push({ op: 'fillRect', x, y, x1: w, y1: h });
      return graphics;
    }),
    fillRoundedRect: vi.fn((x: number, y: number, w: number, h: number) => {
      pending.push({ op: 'fillRoundedRect', x, y, x1: w, y1: h });
      return graphics;
    }),
    fillTriangle: vi.fn(
      (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
        pending.push({ op: 'fillTriangle', x: x1, y: y1, x1, y1, x2, y2, x3, y3 });
        return graphics;
      },
    ),
    strokeCircle: vi.fn(() => graphics),
    strokeRect: vi.fn(() => graphics),
    moveTo: vi.fn((x: number, y: number) => {
      pending.push({ op: 'moveTo', x, y });
      return graphics;
    }),
    lineTo: vi.fn((x: number, y: number) => {
      pending.push({ op: 'lineTo', x, y });
      return graphics;
    }),
    generateTexture: vi.fn((key: string, width: number, height: number) => {
      bakes.push({ key, width, height, commands: pending });
      pending = [];
      return graphics;
    }),
    destroy: vi.fn(),
  };
  const scene = {
    add: {
      graphics: vi.fn(() => graphics as unknown as Phaser.GameObjects.Graphics),
    },
    textures: {
      exists: vi.fn(() => false),
      // canvas-based bakes (welcome sign) fall through to the graphics path
      // when createCanvas is missing, which is fine for these assertions.
    },
  } as unknown as Phaser.Scene;
  return { scene, bakes };
}

function bakeForKey(bakes: TextureBake[], key: string): TextureBake {
  const bake = bakes.find((b) => b.key === key);
  if (!bake) {
    throw new Error(`generateTexture(${key}) was not called`);
  }
  return bake;
}

describe('procedural fallback enemy textures face right', () => {
  it('bakes the rat head circle on the RIGHT half of the texture', () => {
    const { scene, bakes } = createTextureRecordingScene();
    generateTextures(scene);

    const rat = bakeForKey(bakes, '__cw_enemy_rat');
    const cx = rat.width / 2;
    // The head is the fillCircle in the rat texture. There is exactly one.
    const headCircles = rat.commands.filter((c) => c.op === 'fillCircle');
    expect(headCircles).toHaveLength(1);
    const head = headCircles[0]!;
    expect(head.x).toBeGreaterThan(cx);

    // The tail is the moveTo→lineTo pair. Its start should sit on the LEFT
    // half (opposite side of the head) so the whole silhouette reads as a
    // rat facing right.
    const tailStart = rat.commands.find((c) => c.op === 'moveTo');
    expect(tailStart).toBeDefined();
    expect(tailStart!.x).toBeLessThan(cx);
  });

  it('bakes the boss slime-tail triangle on the LEFT half of the texture', () => {
    const { scene, bakes } = createTextureRecordingScene();
    generateTextures(scene);

    const boss = bakeForKey(bakes, '__cw_enemy_boss');
    const cx = boss.width / 2;
    // The boss has several fillTriangle calls (ear spikes + slime tail). The
    // slime tail is the LAST one and is authored below the main body
    // (y > cy=20). All triangles in the tail should sit on the LEFT half so
    // the boss reads as facing right.
    const triangles = boss.commands.filter((c) => c.op === 'fillTriangle');
    const tail = triangles[triangles.length - 1]!;
    // Every vertex of the tail must be on the left half of the canvas.
    for (const key of ['x1', 'x2', 'x3'] as const) {
      const vx = tail[key]!;
      expect(vx).toBeLessThan(cx);
    }
  });
});
