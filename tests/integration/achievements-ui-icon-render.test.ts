import { describe, expect, it } from 'vitest';
import { createAchievementsUI } from '../../src/engine/AchievementsUI.js';
import { ALL_ACHIEVEMENTS } from '../../src/shared/achievements.js';
import {
  GENERATED_MANIFEST_VERSION,
  type GeneratedSpriteRegistry,
} from '../../src/shared/generated-assets.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from '../../src/engine/generatedAssets/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

function toAchievementIconId(iconId: string): string {
  return iconId.endsWith('-placeholder') ? iconId.slice(0, -'-placeholder'.length) : iconId;
}

function makeGameObjectStub(): unknown {
  const stub: unknown = new Proxy(function () {} as unknown as object, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined;
      if (
        prop === 'width' ||
        prop === 'height' ||
        prop === 'displayWidth' ||
        prop === 'displayHeight'
      ) {
        return 64;
      }
      if (
        prop === 'x' ||
        prop === 'y' ||
        prop === 'depth' ||
        prop === 'scaleX' ||
        prop === 'scaleY'
      ) {
        return 0;
      }
      if (prop === 'visible') return true;
      return () => stub;
    },
    set() {
      return true;
    },
    apply() {
      return stub;
    },
  });
  return stub;
}

function makeRecordingScene(
  registry: GeneratedSpriteRegistry,
  imageKeys: string[],
  texturesExist: (key: string) => boolean,
): unknown {
  const stub = makeGameObjectStub();
  return {
    cameras: { main: { roundPixels: false } },
    add: {
      container: () => stub,
      rectangle: () => stub,
      image: (_x: number, _y: number, key: string) => {
        imageKeys.push(key);
        return stub;
      },
      text: () => stub,
    },
    game: {
      registry: {
        get: (key: string) => (key === GENERATED_SPRITE_REGISTRY_KEY ? registry : undefined),
      },
    },
    input: { on: () => {}, off: () => {} },
    scale: { displaySize: { width: 1280, height: 720 }, on: () => {}, off: () => {} },
    textures: { exists: texturesExist },
  };
}

describe('AchievementsUI generated-icon render path', () => {
  it('creates an image for unlocked achievements when generated texture is loaded', () => {
    const achievement = ALL_ACHIEVEMENTS[0];
    expect(achievement).toBeDefined();
    const textureKey = toAchievementIconId(achievement!.iconId);
    const entry = {
      briefId: 'achievement-icons-batch-01',
      textureKey,
      assetPath: `public/assets/generated/${textureKey}.png`,
      anchor: { x: 0.5, y: 0.5 },
      centerOfGravity: { x: 0.5, y: 0.5 },
      anchorIsDefault: false,
      approvedAt: '2026-08-01T00:00:00.000Z',
      sourceRun: 'files/sprites/runs/mock',
      variantIndex: 0,
      sensorScore: '1/1',
      judgeScore: null,
      facingDirection: 'right' as const,
    };
    const entries = Object.freeze([entry]);
    const registry: GeneratedSpriteRegistry = {
      version: GENERATED_MANIFEST_VERSION,
      size: 1,
      has: (briefId) => briefId === entry.briefId,
      lookup: (briefId) => (briefId === entry.briefId ? entry : null),
      variants: (briefId) => (briefId === entry.briefId ? entries : []),
      entries: () => entries,
      briefIds: () => [entry.briefId],
    };
    const imageKeys: string[] = [];
    const scene = makeRecordingScene(registry, imageKeys, (key) => key === textureKey);
    const world = createTestWorld();
    world.achievements.unlockedIds.add(achievement!.id);

    const ui = createAchievementsUI(
      scene as never,
      { open: () => {}, isOpen: () => false } as never,
      { height: 240 },
    );
    ui.toggle(world);

    expect(imageKeys).toContain(textureKey);
  });

  it('does not create an image when generated texture is unavailable', () => {
    const achievement = ALL_ACHIEVEMENTS[0];
    expect(achievement).toBeDefined();
    const textureKey = toAchievementIconId(achievement!.iconId);
    const entry = {
      briefId: 'achievement-icons-batch-01',
      textureKey,
      assetPath: `public/assets/generated/${textureKey}.png`,
      anchor: { x: 0.5, y: 0.5 },
      centerOfGravity: { x: 0.5, y: 0.5 },
      anchorIsDefault: false,
      approvedAt: '2026-08-01T00:00:00.000Z',
      sourceRun: 'files/sprites/runs/mock',
      variantIndex: 0,
      sensorScore: '1/1',
      judgeScore: null,
      facingDirection: 'right' as const,
    };
    const entries = Object.freeze([entry]);
    const registry: GeneratedSpriteRegistry = {
      version: GENERATED_MANIFEST_VERSION,
      size: 1,
      has: (briefId) => briefId === entry.briefId,
      lookup: (briefId) => (briefId === entry.briefId ? entry : null),
      variants: (briefId) => (briefId === entry.briefId ? entries : []),
      entries: () => entries,
      briefIds: () => [entry.briefId],
    };
    const imageKeys: string[] = [];
    const scene = makeRecordingScene(registry, imageKeys, () => false);
    const world = createTestWorld();
    world.achievements.unlockedIds.add(achievement!.id);

    const ui = createAchievementsUI(
      scene as never,
      { open: () => {}, isOpen: () => false } as never,
      { height: 240 },
    );
    ui.toggle(world);

    expect(imageKeys).not.toContain(textureKey);
  });
});
