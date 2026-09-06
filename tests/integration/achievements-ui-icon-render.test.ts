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
  displaySize: { width: number; height: number } = { width: 1280, height: 720 },
): {
  scene: unknown;
  texts: Array<{ text: string; y: number; height: number; destroyed: boolean }>;
} {
  const stub = makeGameObjectStub();
  const texts: Array<{ text: string; y: number; height: number; destroyed: boolean }> = [];
  return {
    scene: {
      cameras: { main: { roundPixels: false } },
      add: {
        container: () => stub,
        rectangle: () => stub,
        image: (_x: number, _y: number, key: string) => {
          imageKeys.push(key);
          return stub;
        },
        text: (
          _x: number,
          y: number,
          text: string,
          style?: { fontSize?: string; wordWrap?: { width: number } },
        ) => {
          const fontSize = Number.parseInt(style?.fontSize ?? '14px', 10);
          const width = style?.wordWrap?.width ?? Number.POSITIVE_INFINITY;
          const charsPerLine = Number.isFinite(width)
            ? Math.max(1, Math.floor(width / (fontSize * 0.55)))
            : Infinity;
          const lineCount = Number.isFinite(charsPerLine)
            ? Math.max(1, Math.ceil(text.length / charsPerLine))
            : 1;
          const record = { text, y, height: lineCount * (fontSize + 4), destroyed: false };
          texts.push(record);
          const proxy = new Proxy(stub as object, {
            get(target, prop) {
              if (prop === 'y') return record.y;
              if (prop === 'height') return record.height;
              if (prop === 'text') return record.text;
              if (prop === 'destroy')
                return () => {
                  record.destroyed = true;
                };
              if (prop === 'setResolution') return () => proxy;
              return Reflect.get(target, prop);
            },
            set(target, prop, value) {
              if (prop === 'y') record.y = value as number;
              return Reflect.set(target, prop, value);
            },
          });
          return proxy;
        },
      },
      game: {
        registry: {
          get: (key: string) => (key === GENERATED_SPRITE_REGISTRY_KEY ? registry : undefined),
        },
      },
      input: { on: () => {}, off: () => {} },
      scale: { displaySize, on: () => {}, off: () => {} },
      textures: { exists: texturesExist },
    },
    texts,
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
    const recording = makeRecordingScene(registry, imageKeys, (key) => key === textureKey);
    const world = createTestWorld();
    world.achievements.unlockedIds.add(achievement!.id);

    const ui = createAchievementsUI(
      recording.scene as never,
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
    const recording = makeRecordingScene(registry, imageKeys, () => false);
    const world = createTestWorld();
    world.achievements.unlockedIds.add(achievement!.id);

    const ui = createAchievementsUI(
      recording.scene as never,
      { open: () => {}, isOpen: () => false } as never,
      { height: 240 },
    );
    ui.toggle(world);

    expect(imageKeys).not.toContain(textureKey);
  });

  it.each([
    { name: 'standard', displaySize: { width: 1280, height: 720 } },
    { name: 'compact', displaySize: { width: 640, height: 360 } },
  ])(
    'keeps title, multiline criteria, and multiline flavor separated at $name size',
    ({ displaySize }) => {
      const achievement = ALL_ACHIEVEMENTS.find(
        (entry) => entry.id === 'floor2-run-fully-outfitted',
      );
      expect(achievement).toBeDefined();
      const recording = makeRecordingScene(
        {
          version: GENERATED_MANIFEST_VERSION,
          size: 0,
          has: () => false,
          lookup: () => null,
          variants: () => [],
          entries: () => [],
          briefIds: () => [],
        },
        [],
        () => false,
        displaySize,
      );
      const world = createTestWorld();
      world.achievements.unlockedIds.add(achievement!.id);

      const ui = createAchievementsUI(
        recording.scene as never,
        { open: () => {}, isOpen: () => false } as never,
        { height: displaySize.height },
      );
      ui.toggle(world);

      const rendered = recording.texts.filter((text) => !text.destroyed);
      const title = rendered.find((text) => text.text === achievement!.title);
      const criteria = rendered.find((text) => text.text === achievement!.unlockCriteria);
      const flavor = rendered.find((text) => text.text === achievement!.directorFlavor);
      expect(title).toBeDefined();
      expect(criteria).toBeDefined();
      expect(flavor).toBeDefined();
      expect(criteria!.height).toBeGreaterThan(20);
      expect(flavor!.height).toBeGreaterThan(20);
      expect(criteria!.y).toBeGreaterThanOrEqual(title!.y + title!.height + 4);
      expect(flavor!.y).toBeGreaterThanOrEqual(criteria!.y + criteria!.height + 6);
    },
  );
});
