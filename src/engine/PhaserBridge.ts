import { hasComponent, query } from 'bitecs';
import type Phaser from 'phaser';
import {
  DeathTimer,
  MeleeSwing,
  Owner,
  Position,
  Prop,
  Rotation,
  SpawnAnim,
  Spawner,
  Sprite,
} from '../core/components.js';
import { getActiveWeaponDef } from '../core/active-weapon.js';
import { isEnemyProjectileTelegraphActive } from '../core/systems/enemyTelegraph.js';
import type { GameWorld } from '../core/world.js';
import { getSprite, getSheet } from './sprites/index.js';
import { createCombatVfx } from './CombatVfx.js';
import { createGoreVfx } from './GoreVfx.js';
import { createCorpseShatterVfx, type CorpseExplodeOptions } from './CorpseShatterVfx.js';
import { createEffectsVfx } from './EffectsVfx.js';
import { createMobAbilityVfx } from './MobAbilityVfx.js';
import { createPlayerTrailVfx } from './PlayerTrailVfx.js';
import { computeCorpseDecay, type CorpseDecay } from './corpse-decay.js';
import { createLogger } from '../shared/logger.js';
import { MeleeSpriteId } from '../shared/constants.js';
import {
  GENERATED_SPRITE_REGISTRY_KEY,
  registerGeneratedSpriteAnimations,
  walkAnimationKey,
} from './generatedAssets/index.js';
import {
  pickGeneratedVariant,
  resolveGeneratedFootprintScale,
  resolveOpaqueFit,
  type GeneratedSpriteAnimation,
  type GeneratedSpriteEntry,
  type GeneratedSpriteRegistry,
  type OpaqueBounds,
} from '../shared/generated-assets.js';
import { ftToPx, PIXELS_PER_FOOT } from '../shared/units.js';
import { DEFAULT_HANDHELD_SPRITE_ANCHOR } from '../shared/sprite-anchor.js';
import {
  combineMobMotion,
  CONTACT_ATTACK_MOTION_MS,
  getRuntimeMobMotionProfile,
  HIT_REACTION_MOTION_MS,
  NEUTRAL_MOB_MOTION,
  RANGED_RELEASE_MOTION_MS,
  sampleContactAttackMotion,
  sampleHitReactionMotion,
  sampleMovementMotion,
  sampleRangedReleaseMotion,
  sampleRangedWindupMotion,
  sampleSpawnMotion,
  sampleSpeedStatusMotion,
  type MobMotionTransform,
  type RuntimeMobMotionProfile,
} from '../shared/mob-motion.js';
import { MINI_SLIME_SPAWN_ANIM_MS } from '../shared/spawn-anim.js';
import { DECORATION_INDEX_TO_ID, getDecorationDef } from '../shared/decorationDefs.js';
import {
  ENTITY_DEPTH,
  PROP_DEPTH,
  TERRAIN_DEPTH,
  WORLD_VFX_DEPTH,
  setPieceZToDepth,
} from '../shared/render-depths.js';
import type { SpriteRef } from '../shared/set-piece-types.js';
import { getHarvestableDefByIndex } from '../shared/harvestableDefs.js';
import {
  generateTextures,
  PROCEDURAL_TEXTURE_KEYS,
  type ProceduralTextureToken,
  TEX_WELCOME_SIGN,
  TEX_WELCOME_SIGN_LEFT,
} from './phaser-bridge/textures.js';
import {
  computeEnemyScale,
  enemyAppearanceTint,
  enemyVariantFromTextureId,
  generatedBriefIdForEnemy,
  pickGeneratedEnemyTextureKey,
  pickGeneratedNpcTextureKey,
  pickGeneratedHarvestableTextureKey,
  refineEnemyVisualKind,
  resolveRenderKind,
  SLIME_FULL_SPRITE_WIDTH,
} from './phaser-bridge/sprite-kind.js';
import { BOSS_BAR_COLORS } from './boss-health-bar-state.js';
import {
  CARRIED_WEAPON_HAND_DROP_FT,
  CARRIED_WEAPON_HAND_OFFSET_FT,
  CARRIED_WEAPON_OBJECT_NAME_PREFIX,
  carriedWeaponLengthFt,
  computeCarriedWeaponPlacement,
  kenneyCarriedWeaponSpriteId,
} from './phaser-bridge/carried-weapon.js';
import { _isPlaceholderEntry, resolveItemSprite } from '../shared/item-sprites.js';
import { hashStringToSeed } from '../shared/random.js';
import type { EntitySpriteMappings } from '../shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../shared/data/entity-sprite-mappings.json';

const DEAD_SKULL_Y_OFFSET = 18;
const MOB_HEALTH_BAR_HEIGHT_PX = 3;
const MOB_HEALTH_BAR_MIN_WIDTH_PX = 16;
const MOB_HEALTH_BAR_MAX_WIDTH_PX = 28;
const MOB_HEALTH_BAR_Y_GAP_PX = 2;
/** Fallback half-height when a sprite's displayHeight is unavailable. */
const MOB_HEALTH_BAR_DEFAULT_SPRITE_HALF_HEIGHT_PX = 8;
const ENEMY_RIGHTWARD_FLIP_EPSILON = 0.001;
const ENEMY_MOVEMENT_MOTION_EPSILON = 0.0001;
const ENEMY_MOVEMENT_MOTION_EPSILON_SQ = ENEMY_MOVEMENT_MOTION_EPSILON ** 2;
/**
 * Minimum speed (ft/s) before the player's walk animation plays. Below this,
 * the player holds its idle (frame-0) pose instead of animating in place —
 * mirrors the enemy movement-motion threshold's intent but is named
 * separately since the player's walk cycle is a distinct, newer concern.
 */
const PLAYER_WALK_SPEED_EPSILON = 0.05;
const PLAYER_WALK_SPEED_EPSILON_SQ = PLAYER_WALK_SPEED_EPSILON ** 2;
const SPEED_STATUS_TINT = 0xaadfff;
/** Fill tint mode value; kept numeric to preserve Node-safe type-only imports. */
export const PHASER_TINT_MODE_FILL = 1;
const logger = createLogger('engine:phaser-bridge');

interface EntityVisual {
  /**
   * Almost every entity renders as a static `Phaser.GameObjects.Image`. The
   * player is the sole exception once its resolved texture carries an
   * `animation` descriptor (see `generatedAnimationByTexture` below) — in
   * that case a `Phaser.GameObjects.Sprite` is created instead so
   * `.anims.play()` is available. Both share every member this file uses
   * (position/scale/flip/texture/etc.); only `.anims` is Sprite-only, so
   * call sites that need it must guard first.
   */
  obj: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite;
  type: string;
  /** Base scale to restore in the default per-frame branch. */
  baseScale: number;
  /**
   * The `registryRevision` value at which `baseScale` was last computed.
   * Used by the enemy texture-key-unchanged branch to skip the
   * `resolveBaseScale` call on frames where the generated registry has not
   * changed — keeping the recompute to the one (or few) frames that follow
   * a late registry load instead of running every frame.
   */
  baseScaleRegistryRevision: number;
  /**
   * Which baked welcome-sign variant is currently applied ('right' arrow vs
   * 'left' arrow). Tracked so the renderer only swaps the texture when the
   * sign's facing hemisphere actually changes.
   */
  welcomeFacing?: 'left' | 'right';
  /**
   * Death-timer duration captured the first frame this corpse is seen dead.
   * Used to normalise the corpse fade/desaturation curve. Undefined while alive.
   */
  deathTotalMs?: number;
}

interface PropVisual {
  obj: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle;
  mode: 'sprite' | 'placeholder';
  textureKey?: string;
  frame?: number;
}

interface MobMotionRenderState {
  readonly generation: number;
  readonly firstSeenMs: number;
  /**
   * Spawn-animation window (ms). Captured at entity first-seen time from
   * `SpawnAnim.totalMs` when the component is present (e.g. 240 ms for
   * spawner children), otherwise `MINI_SLIME_SPAWN_ANIM_MS` (280 ms). Using
   * the entity-specific duration prevents the generic pop-scale from firing
   * for the residual 40 ms after `spawnAnimSystem` removes the component.
   */
  readonly spawnAnimDurationMs: number;
  lastFireMs: number;
  releaseAtMs?: number;
  contactAtMs?: number;
  hitAtMs?: number;
}

const RENDER_KIND_CONFIGS = (ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings).renderKinds;

interface ResolvedTexture {
  key: string;
  /** Frame index when `key` references a spritesheet. */
  frame?: number;
  /** Base render scale for this texture. */
  scale: number;
  /**
   * Authored drawn height of the VISIBLE art in world feet, when the render
   * kind sizes itself in feet (`generated.heightFt`). The caller converts this
   * to a base scale against the loaded texture's opaque bounds via
   * {@link resolveGeneratedFootprintScale}, and falls back to {@link scale}
   * when the texture cannot be measured.
   */
  heightFt?: number;
  /** True when the engine fell back to a procedural __cw_* texture. */
  fallback: boolean;
}

function getGeneratedSpriteRegistry(scene: Phaser.Scene): GeneratedSpriteRegistry | null {
  const registry = scene.game?.registry?.get?.(GENERATED_SPRITE_REGISTRY_KEY);
  if (
    registry &&
    typeof registry === 'object' &&
    typeof (registry as GeneratedSpriteRegistry).variants === 'function'
  ) {
    return registry as GeneratedSpriteRegistry;
  }
  return null;
}

/**
 * Reference footprint in feet for a floor-decoration `Prop` at
 * `DecorationDef.scale === 1.0`. `scale` is documented as a "size multiplier
 * relative to base (1.0 = 100%)", so the Prop render pass multiplies by this
 * constant rather than treating `scale` as an absolute feet value (see the
 * Prop render pass below for the bug this fixes). `3` reads as a "normal
 * sized" hand-placed prop (e.g. a barrel at `scale: 0.9` → 2.7 ft, close to a
 * real barrel's footprint). Exported (with a leading underscore) only so the
 * regression test can assert against the production value instead of
 * duplicating the magic number; it has no production caller outside this file.
 */
export const _PROP_VISUAL_BASE_SIZE_FT = 3;

/**
 * On-floor render scale for a harvestable node's generated sprite. The art is
 * authored at 64px; `0.4` (~26px) matches the enemy node footprint so a
 * harvestable reads at the same visual weight as a small creature and stays
 * framed by the harvest progress ring (radius 9 → 18px).
 */
const HARVEST_NODE_SPRITE_SCALE = 0.4;

/**
 * Depth for a harvestable node's generated sprite: just BELOW the entity plane
 * ({@link ENTITY_DEPTH} = 0) so the player/enemies walk in front of a node, and
 * above terrain/background props so it reads as sitting on the floor. The
 * progress ring is drawn in the node's Graphics at the default depth (0), so it
 * renders on TOP of this sprite.
 */
const HARVEST_NODE_SPRITE_DEPTH = ENTITY_DEPTH - 0.2;

/**
 * Create the generated-sprite Image for a harvestable node, or return `null`
 * when there is no wired/loaded texture (the caller then draws the procedural
 * tinted circle instead). Guards for headless/stub scenes where `scene.add` or
 * the texture cache is unavailable, and never throws on a missing texture.
 */
function createHarvestNodeImage(
  scene: Phaser.Scene,
  textureKey: string | null,
  x: number,
  y: number,
): Phaser.GameObjects.Image | null {
  if (textureKey === null) {
    return null;
  }
  if (typeof scene.add?.image !== 'function' || scene.textures?.exists(textureKey) !== true) {
    return null;
  }
  const img = scene.add.image(x, y, textureKey);
  img.setOrigin(0.5, 0.5);
  img.setScale(HARVEST_NODE_SPRITE_SCALE);
  img.setDepth(HARVEST_NODE_SPRITE_DEPTH);
  return img;
}

/**
 * Resolve a set-piece {@link SpriteRef} to a loaded Phaser texture (and frame),
 * or `null` when nothing usable is loaded (caller draws a placeholder rect).
 *
 * - `sheet`   → a Kenney spritesheet frame (`row * cols + col`).
 * - `catalog` → a catalog (Kenney) sprite when its sheet is loaded, else a
 *   generated sprite loaded under its BARE manifest key (e.g. `welcome-sign-…`).
 * - `custom`  → recurse into the ref's `placeholder` (a catalog/sheet ref) until
 *   the bespoke asset exists; `null` when there is no placeholder.
 */
function resolveSetPieceSprite(
  scene: Phaser.Scene,
  ref: SpriteRef,
): { textureKey: string; frame?: number } | null {
  if (ref.source === 'sheet') {
    const sheet = getSheet(ref.sheetKey);
    if (sheet === undefined || scene.textures?.exists(ref.sheetKey) !== true) {
      return null;
    }
    return { textureKey: ref.sheetKey, frame: ref.row * sheet.cols + ref.col };
  }
  if (ref.source === 'catalog') {
    const normalizedSpriteId = ref.spriteId.startsWith('sprite:')
      ? ref.spriteId.slice('sprite:'.length)
      : ref.spriteId;
    const spriteDef = getSprite(normalizedSpriteId);
    if (spriteDef !== undefined && scene.textures?.exists(spriteDef.sheetKey) === true) {
      return { textureKey: spriteDef.sheetKey, frame: spriteDef.frame };
    }
    // Generated sprites are loaded as individual textures keyed by the bare manifest key.
    if (scene.textures?.exists(normalizedSpriteId) === true) {
      return { textureKey: normalizedSpriteId };
    }
    return null;
  }
  // custom: fall back to the placeholder art until the bespoke asset lands.
  return ref.placeholder !== undefined ? resolveSetPieceSprite(scene, ref.placeholder) : null;
}

/** Parse a `#rrggbb` tint to an integer, or `undefined` when absent/invalid. */
function hexToTintInt(hex: string | undefined): number | undefined {
  if (hex === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(hex.replace('#', ''), 16);
  return Number.isNaN(parsed) ? undefined : parsed;
}
function resolveTexture(
  scene: Phaser.Scene,
  type: string,
  options?: { appearanceKey?: string; variantRoll?: number },
): ResolvedTexture {
  const config = RENDER_KIND_CONFIGS[type];
  const generated = resolveGeneratedTexture(scene, type, config?.generated, options);
  if (generated !== null) {
    return {
      key: generated.key,
      scale: generated.scale,
      ...(generated.heightFt !== undefined ? { heightFt: generated.heightFt } : {}),
      fallback: false,
    };
  }
  const spriteId = config?.kenneySpriteId;
  if (spriteId !== undefined) {
    const sprite = getSprite(spriteId);
    if (sprite !== undefined && scene.textures?.exists(sprite.sheetKey)) {
      return {
        key: sprite.sheetKey,
        frame: sprite.frame,
        scale: config?.kenneyScale ?? 1,
        fallback: false,
      };
    }
  }
  return { key: getProceduralTextureForType(type), scale: 1, fallback: true };
}

/**
 * Render scale for a generated NPC sprite. The three welcome-room NPC sprites
 * ship as 64×64 character PNGs (like the generated enemies), so they use the
 * same 0.4 down-scale the enemy generated art uses — landing a humanoid NPC at
 * ~26px on screen, matching the player's on-screen footprint. Kept a named
 * constant so it reads as an intentional match to the enemy `generated.scale`
 * in `entity-sprite-mappings.json` rather than a magic number.
 */
const GENERATED_NPC_SPRITE_SCALE = 0.4;

/**
 * Resolve an NPC's texture def-aware: some NPCs borrow an enemy appearance key
 * (e.g. the Floor 2 settlement defector wearing a present family's elite art);
 * otherwise prefer a pinned generated NPC sprite keyed by def id; otherwise
 * fall back to the shared Kenney villager through the normal `npc` render-kind
 * path.
 */
function resolveNpcTexture(
  scene: Phaser.Scene,
  defId: string | undefined,
  spriteOverride: SpriteRef | undefined,
  appearanceKey?: string,
  appearanceFallbackKey?: string,
): ResolvedTexture {
  if (spriteOverride !== undefined) {
    const resolvedOverride = resolveSetPieceSprite(scene, spriteOverride);
    if (resolvedOverride !== null) {
      return {
        key: resolvedOverride.textureKey,
        ...(resolvedOverride.frame !== undefined ? { frame: resolvedOverride.frame } : {}),
        scale: resolvedOverride.frame === undefined ? GENERATED_NPC_SPRITE_SCALE : 1,
        fallback: false,
      };
    }
  }
  if (appearanceKey !== undefined) {
    const registry = getGeneratedSpriteRegistry(scene);
    const preferredBriefId =
      registry !== null ? generatedBriefIdForEnemy(undefined, appearanceKey, registry) : undefined;
    if (preferredBriefId !== undefined) {
      const preferredTexture = registry?.variants(preferredBriefId)?.[0]?.textureKey;
      if (preferredTexture) {
        return { key: preferredTexture, scale: GENERATED_NPC_SPRITE_SCALE, fallback: false };
      }
    }
    if (appearanceFallbackKey !== undefined) {
      return resolveTexture(scene, 'enemy', { appearanceKey: appearanceFallbackKey });
    }
    return resolveTexture(scene, 'enemy', { appearanceKey });
  }
  const generatedKey = pickGeneratedNpcTextureKey(defId);
  if (generatedKey !== null && scene.textures?.exists(generatedKey) === true) {
    return { key: generatedKey, scale: GENERATED_NPC_SPRITE_SCALE, fallback: false };
  }
  return resolveTexture(scene, 'npc');
}

/**
 * Textures/appearanceKeys already reported through {@link warnGeneratedTextureUnresolved}
 * this session, so a persistently-unresolvable mapping logs once instead of
 * spamming every render tick.
 */
const generatedTextureUnresolvedWarnings = new Set<string>();

/**
 * `resolveGeneratedTexture` returning `null` means the entity silently falls
 * through to its Kenney/procedural fallback with NO indication that a
 * `generated` mapping was configured but unresolvable. That silence is
 * exactly what let a broken/unwired generated player texture ship
 * undetected in the past (see the Rhea Vale regression, PR #2321) — log
 * once per (type, appearanceKey) so a similar regression is loud instead of
 * silent.
 */
function warnGeneratedTextureUnresolved(
  type: string,
  generated: NonNullable<EntitySpriteMappings['renderKinds'][string]['generated']>,
  appearanceKey: string | undefined,
  effective: { briefId: string; pinnedTextureKey: string },
): void {
  const warningKey = `${type}:${appearanceKey ?? ''}`;
  if (generatedTextureUnresolvedWarnings.has(warningKey)) {
    return;
  }
  generatedTextureUnresolvedWarnings.add(warningKey);
  // Log the EFFECTIVE (post-variant-lookup) descriptor that was actually
  // unresolvable, not just the render kind's top-level default — otherwise a
  // broken per-appearance variant (e.g. a bad `male`/`other` pinnedTextureKey)
  // logs the unrelated top-level/default key and misleads whoever is
  // debugging the regression.
  logger.warn('Generated texture mapping configured but unresolvable; falling through', {
    type,
    appearanceKey,
    briefId: effective.briefId,
    pinnedTextureKey: effective.pinnedTextureKey,
    topLevelBriefId: generated.briefId,
    topLevelPinnedTextureKey: generated.pinnedTextureKey,
  });
}

function resolveGeneratedTexture(
  scene: Phaser.Scene,
  type: string,
  generated: EntitySpriteMappings['renderKinds'][string]['generated'] | undefined,
  options?: { appearanceKey?: string; variantRoll?: number },
): { key: string; scale: number; heightFt?: number } | null {
  if (generated === undefined || scene.textures === undefined) {
    return null;
  }

  // The authored footprint belongs to the RENDER KIND, not to the variant that
  // wins resolution: a Floor 2 family mook resolved through the global
  // appearance-key registry must draw at the same feet as this kind's own
  // pinned art, even though its source PNG is 4-8x larger.
  const heightFt = generated.heightFt !== undefined ? { heightFt: generated.heightFt } : {};

  // Resolution precedence (highest to lowest):
  //   1. The global enemy variant-roll registry (`pickGeneratedEnemyTextureKey`)
  //      — enemy-only; `'player'` is deliberately absent from its backing maps
  //      (`GENERATED_BRIEF_BY_TYPE` / `GENERATED_BRIEF_BY_APPEARANCE_KEY`), so
  //      this always misses for the player and falls through to (2).
  //   2. This render kind's own `generated.variantsByAppearanceKey[appearanceKey]`
  //      (e.g. player gender selecting one of several walk-cycle sheets).
  //   3. The top-level `generated.briefId`/`pinnedTextureKey`/`scale` default.
  // If (1) is ever extended to cover a render kind that ALSO configures
  // `variantsByAppearanceKey`, the registry wins — (2) is local-override-only,
  // it does not shadow the global registry.
  const generatedRegistry = getGeneratedSpriteRegistry(scene);
  const registryKey = pickGeneratedEnemyTextureKey(
    generatedRegistry,
    type,
    options?.variantRoll,
    options?.appearanceKey,
  );
  if (registryKey !== null && scene.textures.exists(registryKey)) {
    return { key: registryKey, scale: generated.scale, ...heightFt };
  }
  if (generatedRegistry !== null && options?.appearanceKey !== undefined) {
    const preferredBriefId = generatedBriefIdForEnemy(
      type,
      options.appearanceKey,
      generatedRegistry,
    );
    const fallbackBriefId = generatedBriefIdForEnemy(type, options.appearanceKey);
    if (
      preferredBriefId !== undefined &&
      fallbackBriefId !== undefined &&
      fallbackBriefId !== preferredBriefId
    ) {
      const fallbackVariants = generatedRegistry.variants(fallbackBriefId);
      if (fallbackVariants.length > 0) {
        const variantRoll = options?.variantRoll;
        const normalizedRoll =
          variantRoll === undefined || !Number.isFinite(variantRoll)
            ? 0
            : Math.min(0.999999, Math.max(0, variantRoll));
        const fallbackIndex = Math.floor(normalizedRoll * fallbackVariants.length);
        const fallbackKey = fallbackVariants[fallbackIndex]?.textureKey;
        if (fallbackKey !== undefined && scene.textures.exists(fallbackKey)) {
          return { key: fallbackKey, scale: generated.scale, ...heightFt };
        }
      }
    }
  }

  const variant =
    options?.appearanceKey !== undefined
      ? generated.variantsByAppearanceKey?.[options.appearanceKey]
      : undefined;
  const effectiveBriefId = variant?.briefId ?? generated.briefId;
  const effectivePinnedTextureKey = variant?.pinnedTextureKey ?? generated.pinnedTextureKey;
  const effectiveScale = variant?.scale ?? generated.scale;

  if (scene.textures.exists(effectivePinnedTextureKey)) {
    return { key: effectivePinnedTextureKey, scale: effectiveScale, ...heightFt };
  }

  if (scene.textures.exists(effectiveBriefId)) {
    return { key: effectiveBriefId, scale: effectiveScale, ...heightFt };
  }

  const textureKeys = scene.textures.getTextureKeys?.();
  if (!Array.isArray(textureKeys)) {
    warnGeneratedTextureUnresolved(type, generated, options?.appearanceKey, {
      briefId: effectiveBriefId,
      pinnedTextureKey: effectivePinnedTextureKey,
    });
    return null;
  }

  const prefix = `${effectiveBriefId}-var-`;
  let selectedKey: string | undefined;
  let selectedVariant = -1;
  for (const key of textureKeys) {
    if (!key.startsWith(prefix) || !scene.textures.exists(key)) {
      continue;
    }
    const variantPart = key.slice(prefix.length);
    const variantIndex = Number.parseInt(variantPart, 10);
    if (!Number.isFinite(variantIndex) || variantIndex < selectedVariant) {
      continue;
    }
    selectedVariant = variantIndex;
    selectedKey = key;
  }
  if (selectedKey === undefined) {
    warnGeneratedTextureUnresolved(type, generated, options?.appearanceKey, {
      briefId: effectiveBriefId,
      pinnedTextureKey: effectivePinnedTextureKey,
    });
    return null;
  }
  return { key: selectedKey, scale: effectiveScale, ...heightFt };
}

function getProceduralTextureForType(type: string): string {
  const token = (RENDER_KIND_CONFIGS[type]?.proceduralTexture ??
    'default') as ProceduralTextureToken;
  return PROCEDURAL_TEXTURE_KEYS[token] ?? PROCEDURAL_TEXTURE_KEYS.default;
}

/**
 * Resolve the still-image texture for a render kind, using the SAME precedence
 * the live renderer uses (approved generated art → Kenney sheet frame →
 * procedural placeholder). Exported for portrait surfaces such as the boss
 * intro lore sheet, which must show the same art the player is about to fight
 * rather than maintaining a second, drift-prone mapping.
 *
 * `appearanceKey` is the entity's own appearance key (`world.enemyAppearanceKeys`).
 * It matters for render kinds shared by many entities — every Floor 2 family
 * boss renders as `enemy_family_boss` and is told apart only by its appearance
 * key — so omitting it would fall back to the kind's default art.
 */
export function resolveRenderKindPortraitTexture(
  scene: Phaser.Scene,
  kind: string,
  appearanceKey?: string,
): { key: string; frame?: number } {
  const config = RENDER_KIND_CONFIGS[kind];
  const generated = resolveGeneratedTexture(
    scene,
    kind,
    config?.generated,
    appearanceKey === undefined ? undefined : { appearanceKey },
  );
  if (generated !== null) {
    return { key: generated.key };
  }
  const spriteId = config?.kenneySpriteId;
  if (spriteId !== undefined) {
    const spriteDef = getSprite(spriteId);
    if (spriteDef !== undefined && scene.textures?.exists(spriteDef.sheetKey) === true) {
      return { key: spriteDef.sheetKey, frame: spriteDef.frame };
    }
  }
  return { key: getProceduralTextureForType(kind) };
}

function resolveMobMotionProfile(
  world: GameWorld,
  eid: number,
): RuntimeMobMotionProfile | undefined {
  if (hasComponent(world.ecs, eid, Spawner)) return undefined;
  const archetypeId =
    world.floorScenario?.enemyArchetypes.get(eid) ??
    world.enemyAppearanceKeys.get(eid) ??
    world.floorExtendedState?.ambientEnemyArchetypes?.get(eid);
  return getRuntimeMobMotionProfile(archetypeId);
}

function hasActiveSpeedStatus(world: GameWorld, eid: number): boolean {
  return (
    world.statusEffectsByEntity
      .get(eid)
      ?.some((effect) => effect.stat === 'speed' && effect.remainingMs > 0) === true
  );
}

function multiplyTint(left: number, right: number): number {
  const r = Math.round((((left >> 16) & 0xff) * ((right >> 16) & 0xff)) / 0xff);
  const g = Math.round((((left >> 8) & 0xff) * ((right >> 8) & 0xff)) / 0xff);
  const b = Math.round(((left & 0xff) * (right & 0xff)) / 0xff);
  return (r << 16) | (g << 8) | b;
}

export function createPhaserBridge(scene: Phaser.Scene): {
  sync(world: GameWorld, renderElapsedMs?: number, interpAlpha?: number): void;
  destroy(): void;
} {
  generateTextures(scene);

  const visuals = new Map<number, EntityVisual>();
  /**
   * Persistent carried main-hand weapon sprite per player entity. Independent
   * of `visuals` (which is keyed by the entity's own sprite) because the
   * weapon is a second display object hanging off the same eid.
   */
  const carriedWeaponVisuals = new Map<number, Phaser.GameObjects.Image>();
  /**
   * Last known horizontal facing per player eid. The player's own sprite flip
   * is only re-derived when |vx| is above the flip epsilon (so standing still
   * doesn't snap the sprite around); the carried weapon must follow the exact
   * same latched facing so hand and body never disagree.
   */
  const playerFacingRightByEid = new Map<number, boolean>();
  const deathMarkers = new Map<number, Phaser.GameObjects.Image>();
  const beamGraphics = new Map<number, Phaser.GameObjects.Graphics>();
  const arcGraphics = new Map<number, Phaser.GameObjects.Graphics>();
  const mobHealthBars = new Map<number, Phaser.GameObjects.Graphics>();
  /** Per-enemy locked-trajectory telegraph cue (see enemyTelegraph.ts). */
  const telegraphGraphics = new Map<number, Phaser.GameObjects.Graphics>();
  /** Tracks spawn time for arc entities so we can animate the sweep. */
  const arcSpawnMs = new Map<number, number>();
  /** Per-harvestable node Graphics (fallback body circle + progress ring redrawn each frame). */
  const harvestNodeGraphics = new Map<number, Phaser.GameObjects.Graphics>();
  /** Per-harvestable node generated-sprite Image (created lazily once its texture is loaded). */
  const harvestNodeImages = new Map<number, Phaser.GameObjects.Image>();
  /** Tracks first-seen render time for XP gems so the bob phase is per-gem. */
  const gemSpawnMs = new Map<number, number>();
  /** Ground shadow ellipses for each XP gem entity. */
  const gemShadows = new Map<number, Phaser.GameObjects.Ellipse>();
  /** Tracks first-seen render time for gold drops so the bob phase is per-coin. */
  const goldSpawnMs = new Map<number, number>();
  /** Ground shadow ellipses for each gold entity. */
  const goldShadows = new Map<number, Phaser.GameObjects.Ellipse>();
  /** Rendered visuals for Prop entities (sprite when wired, rectangle placeholder otherwise). */
  const propVisuals = new Map<number, PropVisual>();
  /**
   * Rendered visuals for render-only set-piece prop layers, keyed by their index
   * in `world.setPieceProps` (these are NOT entities, so there is no eid to key
   * on). The list is append-only and rebuilt on floor reset, so the index is a
   * stable key for the floor's lifetime.
   */
  const setPiecePropVisuals = new Map<number, PropVisual>();
  const combatVfx = createCombatVfx(scene);
  const goreVfx =
    typeof scene.add.rectangle === 'function'
      ? createGoreVfx(scene, { intensity: 1.25, hitGoreEnabled: true })
      : null;
  const corpseShatterVfx =
    typeof scene.add.image === 'function' ? createCorpseShatterVfx(scene) : null;
  const effectsVfx = createEffectsVfx(scene);
  const mobAbilityVfx = createMobAbilityVfx(scene);
  const playerTrailVfx = createPlayerTrailVfx(scene);
  const missingSpriteWarnings = new Set<string>();
  const missingTypeWarnings = new Set<string>();
  let cachedGeneratedRegistry: GeneratedSpriteRegistry | null = null;
  /**
   * Monotonically incremented each time `cachedGeneratedRegistry` changes
   * identity. Entity visuals stamp the revision at which their `baseScale`
   * was last computed; the enemy texture-key-unchanged branch uses this to
   * skip `resolveBaseScale` on frames where the registry has not changed.
   */
  let registryRevision = 0;
  const generatedFacingByTexture = new Map<string, 'left' | 'right'>();
  /**
   * Animation descriptor per generated texture key, so the player render
   * branch can decide whether to create a Sprite (animatable) instead of a
   * plain Image, and which walk-cycle key to play. Rebuilt alongside
   * `generatedFacingByTexture` whenever the registry identity changes.
   */
  const generatedAnimationByTexture = new Map<string, GeneratedSpriteAnimation>();
  /**
   * Opaque pixel bounds per texture key, so the set-piece pass can anchor and
   * scale props by their VISIBLE art instead of the raw canvas. Rebuilt with
   * `generatedFacingByTexture` whenever the registry identity changes.
   */
  const generatedBoundsByTexture = new Map<string, OpaqueBounds>();
  const playerWalkMovingByEid = new Map<number, boolean>();
  const acceptedStepDisplacementByEid = new Map<
    number,
    {
      frameCount: number;
      prevX: number;
      prevY: number;
      currX: number;
      currY: number;
    }
  >();
  const mobMotionStates = new Map<number, MobMotionRenderState>();
  const mobFlashOverlays = new Map<number, Phaser.GameObjects.Image>();
  let lastRenderMs: number | null = null;

  function logFallback(type: string): void {
    const spriteId = RENDER_KIND_CONFIGS[type]?.kenneySpriteId;
    if (spriteId !== undefined) {
      const warningKey = `${type}:${spriteId}`;
      if (missingSpriteWarnings.has(warningKey)) {
        return;
      }
      missingSpriteWarnings.add(warningKey);
      const sprite = getSprite(spriteId);
      logger.warn('Falling back to procedural texture; sprite sheet unavailable', {
        type,
        spriteId,
        sheetKey: sprite?.sheetKey,
      });
    } else {
      if (missingTypeWarnings.has(type)) {
        return;
      }
      missingTypeWarnings.add(type);
      logger.debug('Using procedural texture for entity type without sprite mapping', { type });
    }
  }

  return {
    sync(world: GameWorld, renderElapsedMs = world.elapsedMs, interpAlpha = 0): void {
      const entities = query(world.ecs, [Sprite, Position]);
      const activeEntities = new Set<number>();
      const preferredTextureCache = new Map<string, ResolvedTexture>();
      const generatedRegistry = getGeneratedSpriteRegistry(scene);
      if (generatedRegistry !== cachedGeneratedRegistry) {
        generatedFacingByTexture.clear();
        generatedBoundsByTexture.clear();
        generatedAnimationByTexture.clear();
        if (generatedRegistry) {
          for (const entry of generatedRegistry.entries()) {
            generatedFacingByTexture.set(entry.textureKey, entry.facingDirection);
            if (entry.opaqueBounds !== undefined) {
              generatedBoundsByTexture.set(entry.textureKey, entry.opaqueBounds);
            }
            if (entry.animation !== undefined) {
              generatedAnimationByTexture.set(entry.textureKey, entry.animation);
            }
          }
          registerGeneratedSpriteAnimations(scene, generatedRegistry);
        }
        cachedGeneratedRegistry = generatedRegistry;
        registryRevision++;
        // Expose the registry to the game layer so projectile-origin helpers can
        // resolve per-entity weapon anchors without a Phaser scene reference.
        world.generatedSpriteRegistry = generatedRegistry;
        // Invalidate per-entity cached anchors so the next consumer access
        // recomputes from the updated registry.
        world.entityWeaponAnchors.clear();
      }
      const resolvePreferredTexture = (
        type: string,
        options?: { appearanceKey?: string; variantRoll?: number },
      ): ResolvedTexture => {
        const briefId = generatedBriefIdForEnemy(type, options?.appearanceKey, generatedRegistry);
        const hasGeneratedVariants =
          briefId !== undefined &&
          generatedRegistry !== null &&
          generatedRegistry.variants(briefId).length > 0;
        const cacheKey = `${type}:${options?.appearanceKey ?? ''}:${
          hasGeneratedVariants ? (options?.variantRoll ?? '') : ''
        }`;
        const cached = preferredTextureCache.get(cacheKey);
        if (cached !== undefined) {
          return cached;
        }
        const resolved = resolveTexture(scene, type, options);
        preferredTextureCache.set(cacheKey, resolved);
        return resolved;
      };
      /**
       * Base render scale for a freshly created / retextured visual.
       *
       * When the render kind authors its size in world FEET
       * (`generated.heightFt`), the scale is derived from the loaded texture's
       * OPAQUE bounds so the drawn art is exactly that many feet tall
       * regardless of the canvas the sprite pipeline emitted. Falls back to the
       * legacy `generated.scale` pixel multiplier when the kind authors no
       * height, or when the texture is not measurable (headless/stub scenes,
       * or art that has not decoded yet) — so an unmeasurable texture reverts
       * to the previous look rather than to a bogus size.
       *
       * Frame-based textures (Kenney sheet cells) never take the feet path:
       * `heightFt` is only ever set by the generated resolver, which emits
       * single-image textures.
       */
      const resolveBaseScale = (
        obj: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite,
        resolved: ResolvedTexture,
      ): number =>
        resolveGeneratedFootprintScale({
          bounds: generatedBoundsByTexture.get(resolved.key),
          canvasWidth: obj.width,
          canvasHeight: obj.height,
          targetHeightFt: resolved.heightFt,
          pixelsPerFoot: PIXELS_PER_FOOT,
        }) ?? resolved.scale;

      const { position, velocity, lineDamage, trap, areaDamage, lifetime, meleeSwing } =
        world.stores;

      /**
       * Play (or hold) the player's walk-cycle animation based on current
       * speed. No-ops for any texture without a registered `animation`
       * descriptor (e.g. today's Kenney static frame) and for plain
       * `Image` game objects (no `.anims`), so this is safe to call
       * unconditionally from the player render branch.
       */
      const playPlayerWalkAnimation = (
        obj: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite,
        eid: number,
      ): void => {
        const animatable = obj as Partial<Phaser.GameObjects.Sprite>;
        const anims = animatable.anims;
        if (!anims || typeof anims.play !== 'function') {
          playerWalkMovingByEid.delete(eid);
          return;
        }
        const walkAnimation = generatedAnimationByTexture.get(obj.texture.key);
        if (!walkAnimation) {
          playerWalkMovingByEid.delete(eid);
          return;
        }
        const vx = velocity.x[eid] ?? 0;
        const vy = velocity.y[eid] ?? 0;
        const isMoving = vx * vx + vy * vy > PLAYER_WALK_SPEED_EPSILON_SQ;
        const wasMoving = playerWalkMovingByEid.get(eid) ?? false;
        if (isMoving) {
          // `true` (ignoreIfPlaying) avoids restarting looped cycles from frame 0
          // every render tick while the player keeps moving. For one-shot
          // (`loop=false`) walk strips, replay only when movement transitions from
          // rest -> moving; otherwise Phaser marks the anim complete and repeated
          // `play()` would incorrectly loop the one-shot on every sync.
          if (walkAnimation.loop || !wasMoving) {
            anims.play(walkAnimationKey(obj.texture.key), true);
          }
        } else if (wasMoving && typeof anims.stop === 'function') {
          anims.stop();
          // `stop()` freezes on whatever mid-stride frame the cycle was on —
          // explicitly snap back to frame 0, the sheet's designated idle
          // pose, so resting always reads as a clean standing frame rather
          // than a frozen stride. See `GeneratedSpriteAnimation` contract.
          if (typeof (animatable as Partial<Phaser.GameObjects.Sprite>).setFrame === 'function') {
            (animatable as Phaser.GameObjects.Sprite).setFrame(0);
          }
        }
        playerWalkMovingByEid.set(eid, isMoving);
      };

      /**
       * Eids that currently own a live melee swing. The swing branch draws its
       * own weapon sprite pivoting from the player's centre, so the carried
       * sprite hides for the duration to avoid rendering the weapon twice.
       */
      const swingOwners = new Set<number>();
      for (const swingEid of query(world.ecs, [MeleeSwing, Owner])) {
        const owner = world.stores.owner.eid[swingEid];
        if (owner !== undefined) {
          swingOwners.add(owner);
        }
      }

      /**
       * Draw (or hide) the player's equipped main-hand weapon as a persistent
       * carried sprite, so the weapon is visible between swings and for weapon
       * types that never spawn a swing entity at all.
       *
       * Art resolution mirrors the swing branch's preference order: approved
       * generated art first, then the Kenney placeholder for melee weapons,
       * then any generated placeholder entry — so a weapon with no art at all
       * simply renders nothing rather than a misleading stand-in.
       */
      const updateCarriedWeapon = (
        eid: number,
        playerX: number,
        playerY: number,
        playerVisible: boolean,
      ): void => {
        const hideCarried = (): void => {
          const existing = carriedWeaponVisuals.get(eid);
          if (existing) {
            existing.setVisible(false);
          }
        };
        if (typeof scene.add.image !== 'function') {
          return;
        }
        const weaponDef = getActiveWeaponDef(world);
        if (!weaponDef || !playerVisible || swingOwners.has(eid)) {
          hideCarried();
          return;
        }

        const generatedEntry = generatedRegistry
          ? resolveItemSprite(
              generatedRegistry,
              weaponDef.id,
              (hashStringToSeed(weaponDef.id) ^ world.seed) | 0,
            )
          : null;
        const generatedReady =
          generatedEntry !== null && scene.textures?.exists?.(generatedEntry.textureKey) === true;
        const kenneySpriteId = kenneyCarriedWeaponSpriteId(weaponDef.id, weaponDef.weaponType);
        const fallbackSpriteDef = kenneySpriteId ? getSprite(kenneySpriteId) : undefined;
        // Real approved art wins; a generated PLACEHOLDER only wins when there
        // is no hand-picked Kenney stand-in for this weapon (i.e. non-melee),
        // so a melee weapon never downgrades to placeholder art.
        const useGenerated =
          generatedEntry !== null &&
          generatedReady &&
          (!_isPlaceholderEntry(generatedEntry) || fallbackSpriteDef === undefined);

        let textureKey: string | null = null;
        let frame: string | number | undefined;
        let holdX = DEFAULT_HANDHELD_SPRITE_ANCHOR.x;
        let holdY = DEFAULT_HANDHELD_SPRITE_ANCHOR.y;
        let frameWidth = 16;
        let frameHeight = 16;
        let isGeneratedArt = false;

        if (useGenerated && generatedEntry !== null) {
          textureKey = generatedEntry.textureKey;
          holdX = generatedEntry.anchor.x;
          holdY = generatedEntry.anchor.y;
          isGeneratedArt = true;
          const src = scene.textures.get(textureKey).getSourceImage() as
            | { width?: number; height?: number }
            | undefined;
          const w = src?.width;
          const h = src?.height;
          if (typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0) {
            frameWidth = w;
            frameHeight = h;
          }
        } else if (fallbackSpriteDef) {
          textureKey = fallbackSpriteDef.sheetKey;
          frame = fallbackSpriteDef.frame;
        }

        if (textureKey === null) {
          hideCarried();
          return;
        }

        const placement = computeCarriedWeaponPlacement({
          playerX,
          playerY,
          facingRight: playerFacingRightByEid.get(eid) ?? true,
          handOffsetPx: ftToPx(CARRIED_WEAPON_HAND_OFFSET_FT),
          handDropPx: ftToPx(CARRIED_WEAPON_HAND_DROP_FT),
          lengthPx: ftToPx(carriedWeaponLengthFt(weaponDef)),
          holdX,
          holdY,
          frameWidth,
          frameHeight,
          clampMinScale: !isGeneratedArt,
        });

        let img = carriedWeaponVisuals.get(eid);
        if (!img) {
          img =
            frame !== undefined
              ? scene.add.image(placement.x, placement.y, textureKey, frame)
              : scene.add.image(placement.x, placement.y, textureKey);
          // Named so a real-scene probe can identify the carried weapon on the
          // display list (mirrors the blood-pool / quest-arrow naming pattern).
          if (typeof img.setName === 'function') {
            img.setName(`${CARRIED_WEAPON_OBJECT_NAME_PREFIX}${eid}`);
          }
          carriedWeaponVisuals.set(eid, img);
        } else {
          // Reconcile only on a real change (late generated-art load, or a
          // weapon switch), mirroring the swing branch's guard so a stable
          // weapon never re-`setTexture`s every frame.
          const keyChanged = img.texture.key !== textureKey;
          const frameChanged =
            !keyChanged && frame !== undefined && String(img.frame?.name) !== String(frame);
          if (keyChanged || frameChanged) {
            if (frame !== undefined) {
              img.setTexture(textureKey, frame);
            } else {
              img.setTexture(textureKey);
            }
          }
        }
        img.setOrigin(placement.originX, placement.originY);
        img.setScale(placement.scale);
        img.setPosition(placement.x, placement.y);
        img.setRotation(placement.rotation);
        img.setAlpha(1);
        img.setVisible(true);
        if (typeof img.setDepth === 'function') {
          // Just above the entity plane so the weapon reads as held in front of
          // the body without escaping the world-space camera.
          img.setDepth(ENTITY_DEPTH + 0.002);
        }
      };

      const ensureMobMotionState = (
        eid: number,
        initialLastFireMs: number,
      ): MobMotionRenderState => {
        const generation = world.entityRenderGeneration[eid] ?? 0;
        const existing = mobMotionStates.get(eid);
        if (existing?.generation === generation) return existing;
        // Capture the entity-specific spawn-animation duration. Spawner children
        // carry a SpawnAnim component with a shorter totalMs (e.g. 240 ms); using
        // that value as the window prevents the generic pop-scale from firing for
        // the residual frames after spawnAnimSystem removes the component.
        const spawnAnimDurationMs = hasComponent(world.ecs, eid, SpawnAnim)
          ? (world.stores.spawnAnim.totalMs[eid] ?? MINI_SLIME_SPAWN_ANIM_MS)
          : MINI_SLIME_SPAWN_ANIM_MS;
        const state: MobMotionRenderState = {
          generation,
          firstSeenMs: renderElapsedMs,
          spawnAnimDurationMs,
          lastFireMs: initialLastFireMs,
        };
        mobMotionStates.set(eid, state);
        return state;
      };

      // Capture authoritative hit events before CombatVfx drains the queue.
      // Generation guards prevent stale events from a recycled EID being
      // applied to the new occupant when multiple sim steps run before one render.
      for (const event of world.combatEvents) {
        if (event.type !== 'hit') continue;
        if (event.targetType === 'enemy' && event.targetEid !== undefined) {
          if (!resolveMobMotionProfile(world, event.targetEid)) continue;
          const expectedGen = event.targetRenderGeneration;
          if (
            expectedGen === undefined ||
            world.entityRenderGeneration[event.targetEid] !== expectedGen
          ) {
            continue;
          }
          const state = ensureMobMotionState(
            event.targetEid,
            world.stores.enemyBehavior.lastFireMs[event.targetEid] ?? 0,
          );
          state.hitAtMs = event.timestamp;
        }
        if (
          event.targetType === 'player' &&
          event.delivery === 'contact' &&
          event.sourceEid !== undefined
        ) {
          if (!resolveMobMotionProfile(world, event.sourceEid)) continue;
          const expectedGen = event.sourceRenderGeneration;
          if (
            expectedGen === undefined ||
            world.entityRenderGeneration[event.sourceEid] !== expectedGen
          ) {
            continue;
          }
          const state = ensureMobMotionState(
            event.sourceEid,
            world.stores.enemyBehavior.lastFireMs[event.sourceEid] ?? 0,
          );
          state.contactAtMs = event.timestamp;
        }
      }

      // Corpse explosions: capture the texture to cut up NOW, while the dead
      // enemy's visual is still in the map (it gets reaped by the cleanup loop
      // below, since deathTimerSystem already removed the entity this frame).
      // We replay these into the VFX after its per-frame clock advances.
      let pendingShatter: CorpseExplodeOptions[] | null = null;
      if (corpseShatterVfx) {
        for (const event of world.combatEvents) {
          if (event.type !== 'corpseExplode') continue;
          const eid = event.targetEid;
          const visual = eid !== undefined ? visuals.get(eid) : undefined;
          let textureKey: string;
          let frame: string | number | undefined;
          let scale: number;
          let tint: number | undefined;
          if (visual && visual.type.startsWith('enemy') && visual.obj.texture) {
            textureKey = visual.obj.texture.key;
            frame = visual.obj.frame?.name;
            // Use the live render scale magnitude (not baseScale) so shrunken
            // variants like baby slimes shatter at their actual on-screen
            // size even when the render path horizontally flips them.
            scale = Math.abs(visual.obj.scaleX) || visual.baseScale;
            tint = visual.obj.isTinted ? visual.obj.tintTopLeft : undefined;
          } else {
            const tex = resolveTexture(scene, enemyVariantFromTextureId(event.spriteTextureId), {
              appearanceKey: event.spriteAppearanceKey,
              variantRoll: event.spriteVariantRoll,
            });
            textureKey = tex.key;
            frame = tex.frame;
            scale = tex.scale * (event.spriteSizeScale ?? 1);
            if (event.spriteAppearanceKey === 'slime-mini') {
              const slimeMiniMul = Math.max(
                0.2,
                Math.min(
                  1,
                  (event.spriteWidth ?? SLIME_FULL_SPRITE_WIDTH) / SLIME_FULL_SPRITE_WIDTH,
                ),
              );
              scale *= slimeMiniMul;
            }
          }
          (pendingShatter ??= []).push({
            // event.x/event.y are world feet; CorpseShatterVfx works in render
            // pixels, so convert at this boundary like every other bridge coord.
            x: ftToPx(event.x),
            y: ftToPx(event.y),
            textureKey,
            frame,
            scale,
            tint,
            bloodColor: event.bloodColor ?? 0xcc0000,
            dirX: event.knockbackDirX ?? 0,
            dirY: event.knockbackDirY ?? 0,
            amount: event.amount,
          });
        }
      }

      for (const eid of entities) {
        if (hasComponent(world.ecs, eid, Prop)) {
          // Props are rendered in a dedicated pass below.
          continue;
        }
        activeEntities.add(eid);

        const entityType = resolveRenderKind(world, eid);
        let isBoss = false;
        let bossKey: string | null = null;
        if (entityType === 'enemy' && world.floorScenario != null) {
          for (const [key, battle] of world.floorScenario.objective.bossBattles.entries()) {
            if (battle.bossEid === eid) {
              isBoss = true;
              bossKey = key;
              break;
            }
          }
        }
        const visualType =
          entityType === 'enemy'
            ? isBoss
              ? bossKey === 'staircase'
                ? 'enemy_boss_ratslime'
                : bossKey === 'slime-rat'
                  ? 'enemy_boss_slimerat'
                  : 'enemy_boss'
              : refineEnemyVisualKind(world, eid)
            : entityType;
        const appearanceKey =
          entityType === 'enemy'
            ? world.enemyAppearanceKeys.get(eid)
            : entityType === 'player'
              ? world.playerGender
              : undefined;
        // Positions/velocities are stored in feet; scale feet → pixels for
        // rendering (the only place pixels exist). All downstream geometry
        // (beam/melee/aoe lengths, tip offsets) is computed in pixels too.
        const positionX = position.x[eid] ?? 0;
        const positionY = position.y[eid] ?? 0;
        let sample = acceptedStepDisplacementByEid.get(eid);
        if (!sample) {
          sample = {
            frameCount: world.frameCount,
            prevX: positionX,
            prevY: positionY,
            currX: positionX,
            currY: positionY,
          };
          acceptedStepDisplacementByEid.set(eid, sample);
        } else if (sample.frameCount !== world.frameCount) {
          sample.prevX = sample.currX;
          sample.prevY = sample.currY;
          sample.currX = positionX;
          sample.currY = positionY;
          sample.frameCount = world.frameCount;
        } else if (sample.currX !== positionX || sample.currY !== positionY) {
          // Position changed without an accompanying sim frame tick (teleport,
          // spawn, floor transitions): snap to the new position and render from
          // there with zero extrapolation to avoid stale offsets.
          sample.prevX = positionX;
          sample.prevY = positionY;
          sample.currX = positionX;
          sample.currY = positionY;
        }
        const stepDx = sample.currX - sample.prevX;
        const stepDy = sample.currY - sample.prevY;
        const x = ftToPx(sample.currX + stepDx * interpAlpha);
        const y = ftToPx(sample.currY + stepDy * interpAlpha);

        // --- Harvestable node rendering (generated sprite when wired, else a
        // procedural tinted circle) + harvest progress ring ---
        if (entityType === 'harvestable') {
          let hg = harvestNodeGraphics.get(eid);
          if (!hg) {
            hg = scene.add.graphics();
            harvestNodeGraphics.set(eid, hg);
          }
          hg.clear();

          const defIndex = world.stores.harvestable.defIndex[eid] ?? 0;
          const def = getHarvestableDefByIndex(defIndex);
          const nodeColor = def?.tint ?? 0x44aa44;
          const progressMs = world.stores.harvestable.progressMs[eid] ?? 0;
          const durationMs = world.stores.harvestable.durationMs[eid] ?? 1;
          const BODY_RADIUS = 5;
          const RING_RADIUS = 9;
          const RING_WIDTH = 3;

          // Prefer a wired generated sprite. Resolve lazily and DO NOT cache a
          // null result, so a late-loading texture is still picked up on a later
          // frame (unwired node types simply keep hitting the cheap circle path).
          let nodeImg = harvestNodeImages.get(eid) ?? null;
          if (!nodeImg) {
            const textureKey = pickGeneratedHarvestableTextureKey(
              generatedRegistry,
              def?.id,
              world.stores.sprite.variantRoll[eid],
            );
            nodeImg = createHarvestNodeImage(scene, textureKey, x, y);
            if (nodeImg) {
              harvestNodeImages.set(eid, nodeImg);
            }
          }

          // Node body: generated sprite when available, else the filled circle.
          if (nodeImg) {
            nodeImg.setPosition(x, y);
          } else {
            hg.lineStyle(1, 0x000000, 0.7);
            hg.fillStyle(nodeColor, 1.0);
            hg.fillCircle(x, y, BODY_RADIUS);
            hg.strokeCircle(x, y, BODY_RADIUS);
          }

          // Progress ring: visible only while being harvested. Drawn in `hg`
          // (default depth 0) so it reads on top of the node sprite (which sits
          // just below the entity plane).
          if (progressMs > 0) {
            const progress = Math.min(1, progressMs / durationMs);
            // Background track ring.
            hg.lineStyle(RING_WIDTH, 0x333333, 0.7);
            hg.strokeCircle(x, y, RING_RADIUS);

            // Filled arc from 12 o'clock (−π/2) clockwise.
            const startAngle = -Math.PI / 2;
            const endAngle = startAngle + Math.PI * 2 * progress;
            hg.lineStyle(RING_WIDTH, 0x44ff88, 1.0);
            hg.beginPath();
            hg.arc(x, y, RING_RADIUS, startAngle, endAngle, false);
            hg.strokePath();
          }

          // Harvestable nodes manage their own Graphics/Image — skip the shared image path.
          continue;
        }

        // --- Beam rendering (uses Graphics, not Image) ---
        if (entityType === 'beam') {
          let bg = beamGraphics.get(eid);
          if (!bg) {
            bg = scene.add.graphics();
            beamGraphics.set(eid, bg);
          }
          bg.clear();

          const dirX = lineDamage.dirX[eid] ?? 1;
          const dirY = lineDamage.dirY[eid] ?? 0;
          const length = ftToPx(lineDamage.length[eid] ?? 0);

          // Lifetime fade
          const expiresAt = lifetime.expiresAtMs[eid] ?? 0;
          const remaining = Math.max(0, expiresAt - renderElapsedMs);
          const alpha = Math.min(1, remaining / 200);

          // Core beam line
          bg.lineStyle(4, 0x00ffff, alpha * 0.9);
          bg.beginPath();
          bg.moveTo(x, y);
          bg.lineTo(x + dirX * length, y + dirY * length);
          bg.strokePath();

          // Glow line (wider, more transparent)
          bg.lineStyle(10, 0x00aaff, alpha * 0.25);
          bg.beginPath();
          bg.moveTo(x, y);
          bg.lineTo(x + dirX * length, y + dirY * length);
          bg.strokePath();

          // Hide the image for beam entities
          const existing = visuals.get(eid);
          if (existing) {
            existing.obj.setVisible(false);
          }
          continue;
        }

        // --- Melee swing rendering (Graphics arc + weapon sprite at tip) ---
        if (entityType === 'melee_swing') {
          let ag = arcGraphics.get(eid);
          if (!ag) {
            ag = scene.add.graphics();
            arcGraphics.set(eid, ag);
            arcSpawnMs.set(eid, renderElapsedMs);
          }
          ag.clear();

          const bladeLen = ftToPx(meleeSwing.bladeLength[eid] ?? 0);
          const arcCenter = meleeSwing.arcCenterRad[eid] ?? 0;
          const arcHalf = meleeSwing.arcHalfRad[eid] ?? 0;
          const style = meleeSwing.style[eid] ?? 0;
          const headRadius = ftToPx(meleeSwing.headRadius[eid] ?? 0);
          const spawnTime = arcSpawnMs.get(eid) ?? renderElapsedMs;
          const expiresAt = lifetime.expiresAtMs[eid] ?? 0;
          const totalDuration = Math.max(1, expiresAt - spawnTime);
          const elapsed = renderElapsedMs - spawnTime;
          const progress = Math.min(1, Math.max(0, elapsed / totalDuration));

          // Lifetime fade
          const remaining = Math.max(0, expiresAt - renderElapsedMs);
          const alpha = Math.min(1, remaining / 50);

          let tipX: number;
          let tipY: number;
          let tipAngle: number;

          if (style === 1) {
            // Stab: extend forward then retract
            const reach =
              progress <= 0.5 ? (progress / 0.5) * bladeLen : ((1 - progress) / 0.5) * bladeLen;
            tipX = x + Math.cos(arcCenter) * reach;
            tipY = y + Math.sin(arcCenter) * reach;
            tipAngle = arcCenter;

            // Shaft line (faint trail)
            ag.lineStyle(headRadius > 0 ? 1 : 2, 0xdddddd, alpha * 0.4);
            ag.beginPath();
            ag.moveTo(x, y);
            ag.lineTo(tipX, tipY);
            ag.strokePath();
          } else {
            // Slash: sweep through arc
            const startAngle = arcCenter + arcHalf;
            const endAngle = arcCenter - arcHalf;
            const currentAngle = startAngle + (endAngle - startAngle) * progress;
            tipX = x + Math.cos(currentAngle) * bladeLen;
            tipY = y + Math.sin(currentAngle) * bladeLen;
            tipAngle = currentAngle;

            // Faint trail arc showing the swept area
            if (progress > 0.05) {
              ag.lineStyle(2, 0xffffaa, 0.12 * alpha);
              ag.beginPath();
              ag.arc(x, y, bladeLen, startAngle, currentAngle, startAngle > endAngle);
              ag.strokePath();
            }

            // Shaft line (faint)
            ag.lineStyle(headRadius > 0 ? 1 : 2, 0xcccccc, alpha * 0.3);
            ag.beginPath();
            ag.moveTo(x, y);
            ag.lineTo(tipX, tipY);
            ag.strokePath();
          }

          // --- Weapon sprite pivoting from the player center ---
          // The hold anchor marks the grip pixel; we pin it to the player
          // center so the weapon appears held at the body.
          //
          // Derivation: with rotation = tipAngle + π/2 the local-up direction
          // (0,−1) maps to screen direction (cos tipAngle, sin tipAngle), so the
          // tip of the sprite is at origin + holdAnchor.y × scale × (cos, sin).
          // Setting holdAnchor.y × scale = bladeLen makes the sprite tip land
          // exactly at tipX/tipY while the grip stays at the player center.
          const handX = x;
          const handY = y;

          const swingSprite = meleeSwing.spriteId[eid] ?? 0;

          // Prefer the approved generated art for the in-world swing. Only the
          // bat has approved generated melee art today — the sword branch still
          // resolves to the Kenney placeholder. The inventory/equipment panels
          // resolve item art via `resolveItemSprite` (ADR 0051); this swing path
          // stays a direct briefId lookup until the bat art is migrated to a
          // single bare `baseball-bat` lineage. When a `sword-v1` (or hammer
          // variant) gets approved, add its briefId here.
          const generatedBriefId = swingSprite === MeleeSpriteId.BAT ? 'baseball-bat' : null;
          const generatedRegistry = generatedBriefId ? getGeneratedSpriteRegistry(scene) : null;
          const generatedEntry: GeneratedSpriteEntry | null =
            generatedRegistry && generatedBriefId
              ? pickGeneratedVariant(generatedRegistry, generatedBriefId, eid | 0)
              : null;
          const generatedTextureReady =
            generatedEntry !== null && scene.textures?.exists?.(generatedEntry.textureKey) === true;

          const fallbackSpriteKey =
            swingSprite === MeleeSpriteId.BAT ? 'weapon.bat' : 'weapon.sword';
          const fallbackSpriteDef = getSprite(fallbackSpriteKey);

          // Resolve texture + anchor + frame size. Defaults describe the
          // Kenney tiny-dungeon 16×16 handheld convention; generated art can
          // ship at 32×32 or 64×64 with its own hold anchor.
          let weaponTextureKey: string | null = null;
          let weaponFrame: string | number | undefined;
          let holdX = DEFAULT_HANDHELD_SPRITE_ANCHOR.x;
          let holdY = DEFAULT_HANDHELD_SPRITE_ANCHOR.y;
          let frameWidth = 16;
          let frameHeight = 16;

          if (generatedEntry && generatedTextureReady) {
            weaponTextureKey = generatedEntry.textureKey;
            weaponFrame = undefined;
            holdX = generatedEntry.anchor.x;
            holdY = generatedEntry.anchor.y;
            const src = scene.textures.get(weaponTextureKey).getSourceImage() as
              | { width?: number; height?: number }
              | undefined;
            const w = src?.width;
            const h = src?.height;
            if (typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0) {
              frameWidth = w;
              frameHeight = h;
            }
          } else if (fallbackSpriteDef) {
            weaponTextureKey = fallbackSpriteDef.sheetKey;
            weaponFrame = fallbackSpriteDef.frame;
          }

          // Minimum scale ensuring the sprite remains visually readable for
          // very short weapons where the computed scale would be near-zero.
          // Only applied to the 16×16 Kenney fallback path — generated art
          // ships at 32/64 px so its natural size is already readable, and
          // clamping the scale would decouple the tip from `bladeLen`
          // (e.g. baseball-bat is 64×64 with holdY=60; bladeLen=44 gives
          // rawScale ≈ 0.73, clamped to 1.8 would put the tip ~108 px away
          // from the hand instead of 44).
          const MIN_WEAPON_SPRITE_SCALE = 1.8;
          const isGeneratedWeaponSprite = generatedEntry !== null && generatedTextureReady;
          const rawWeaponScale = holdY > 0 ? bladeLen / holdY : 1;
          const weaponScale =
            !isGeneratedWeaponSprite && rawWeaponScale < MIN_WEAPON_SPRITE_SCALE
              ? MIN_WEAPON_SPRITE_SCALE
              : rawWeaponScale;
          const originX = frameWidth > 0 ? holdX / frameWidth : 0.5;
          const originY =
            frameHeight > 0 ? holdY / frameHeight : DEFAULT_HANDHELD_SPRITE_ANCHOR.y / 16;

          let visual = visuals.get(eid);
          if (!visual && weaponTextureKey !== null) {
            const img =
              weaponFrame !== undefined
                ? scene.add.image(handX, handY, weaponTextureKey, weaponFrame)
                : scene.add.image(handX, handY, weaponTextureKey);
            // Origin at hold anchor so the sprite pivots from the player's hand
            img.setOrigin(originX, originY);
            img.setScale(weaponScale);
            visuals.set(eid, {
              obj: img,
              type: entityType,
              baseScale: weaponScale,
              baseScaleRegistryRevision: registryRevision,
            });
            visual = visuals.get(eid);
          }

          if (visual && weaponTextureKey !== null) {
            const img = visual.obj;
            // Reconcile to the preferred texture key + frame only when it
            // actually changes, so a stable swing does not re-`setTexture` every
            // frame. Two cases warrant a reconcile:
            //   (a) the texture KEY changed — the generated manifest finished
            //       loading mid-swing (Kenney sheet → generated texture), or a
            //       procedural placeholder resolved to real art; or
            //   (b) the key is unchanged but the FRAME changed — an eid reuse
            //       landed a different weapon on the same Kenney sheet
            //       (bat frame 117 ↔ sword frame 104).
            // Frames are compared ONLY when the key already matches and a
            // specific frame is requested, and both sides are String()-coerced.
            // A spritesheet's `frame.name` is numeric (117) while `weaponFrame`
            // is a number, and a texture loaded via `loader.image` has a single
            // frame Phaser names '__BASE' (never `undefined`). Comparing those
            // raw values mis-fired every frame — `'__BASE' !== undefined` and
            // `117 !== '117'` both stay true forever, defeating the guard and
            // re-applying the texture on every swing frame. Mirrors the enemy
            // reconcile pattern below.
            const currentKey = img.texture.key;
            const keyChanged = currentKey !== weaponTextureKey;
            const frameChanged =
              !keyChanged &&
              weaponFrame !== undefined &&
              String(img.frame?.name) !== String(weaponFrame);
            if (keyChanged || frameChanged) {
              if (weaponFrame !== undefined) {
                img.setTexture(weaponTextureKey, weaponFrame);
              } else {
                img.setTexture(weaponTextureKey);
              }
            }
            img.setVisible(alpha > 0.05);
            img.setAlpha(alpha);
            // Recompute origin/scale each frame in case the sprite was reused
            img.setOrigin(originX, originY);
            img.setScale(weaponScale);
            img.setPosition(handX, handY);
            // +π/2 aligns local-up (blade tip) with tipAngle (away from player)
            img.setRotation(tipAngle + Math.PI / 2);
          }
          continue;
        }
        let visual = visuals.get(eid);

        if (!visual || visual.type !== visualType) {
          if (visual) {
            visual.obj.destroy();
          }
          const npcInstance = world.npcs.get(eid);
          const resolved =
            entityType === 'npc'
              ? resolveNpcTexture(
                  scene,
                  npcInstance?.defId,
                  npcInstance?.spriteOverride,
                  world.enemyAppearanceKeys.get(eid),
                  npcInstance?.appearanceFallbackKey,
                )
              : resolveTexture(scene, visualType, {
                  appearanceKey,
                  variantRoll: world.stores.sprite.variantRoll[eid],
                });
          const hasWalkAnimation = generatedAnimationByTexture.has(resolved.key);
          const img =
            hasWalkAnimation && typeof scene.add.sprite === 'function'
              ? resolved.frame !== undefined
                ? scene.add.sprite(x, y, resolved.key, resolved.frame)
                : scene.add.sprite(x, y, resolved.key)
              : resolved.frame !== undefined
                ? scene.add.image(x, y, resolved.key, resolved.frame)
                : scene.add.image(x, y, resolved.key);
          const baseScale = resolveBaseScale(img, resolved);
          if (baseScale !== 1) {
            img.setScale(baseScale);
          }
          if (resolved.fallback) {
            logFallback(visualType);
          }
          visual = {
            obj: img,
            type: visualType,
            baseScale,
            baseScaleRegistryRevision: registryRevision,
          };
          visuals.set(eid, visual);
        }

        let img = visual.obj;
        if (entityType === 'enemy') {
          const preferred = resolvePreferredTexture(visualType, {
            appearanceKey,
            variantRoll: world.stores.sprite.variantRoll[eid],
          });
          // Enemy visuals may be created before generated textures are ready
          // (e.g. timeout/late load). Reconcile to the preferred texture key when
          // it becomes available so slimes/rats upgrade off placeholder art.
          if (img.texture.key !== preferred.key) {
            img.setTexture(preferred.key, preferred.frame);
            visual.baseScale = resolveBaseScale(img, preferred);
            visual.baseScaleRegistryRevision = registryRevision;
            img.setScale(visual.baseScale);
            // Invalidate the cached weapon anchor so the next game-layer access
            // recomputes from the updated variant entry.
            world.entityWeaponAnchors.delete(eid);
          } else if (visual.baseScaleRegistryRevision !== registryRevision) {
            // Recompute base scale when opaque bounds became available after the
            // entity was first rendered (late generated-sprite registry load).
            // Gated on `registryRevision` so this is a no-op on every frame
            // after bounds have stabilised — the registry identity only changes
            // on the one (or few) frames that follow a late load, not every
            // frame, so `resolveBaseScale` is not called per-entity per-frame.
            const freshScale = resolveBaseScale(img, preferred);
            if (freshScale !== visual.baseScale) {
              visual.baseScale = freshScale;
            }
            visual.baseScaleRegistryRevision = registryRevision;
          }
        }
        if (entityType === 'npc') {
          // NPC visuals may be created before their pinned generated texture has
          // finished loading. Reconcile to the def-aware generated sprite once it
          // is available so each welcome-room NPC upgrades off the shared Kenney
          // villager placeholder (mirrors the enemy late-load reconcile above).
          const npcInstance = world.npcs.get(eid);
          const preferred = resolveNpcTexture(
            scene,
            npcInstance?.defId,
            npcInstance?.spriteOverride,
            world.enemyAppearanceKeys.get(eid),
            npcInstance?.appearanceFallbackKey,
          );
          if (img.texture.key !== preferred.key) {
            img.setTexture(preferred.key, preferred.frame);
            visual.baseScale = resolveBaseScale(img, preferred);
            img.setScale(visual.baseScale);
          }
        }
        if (entityType === 'player') {
          // The player visual may be created (e.g. on floor-load / carryover)
          // before its gender-keyed generated texture has finished loading, or
          // may still be showing another gender's texture from a stale
          // `visuals` cache entry keyed only by `visualType` (which is always
          // 'player', so the type-mismatch recreate branch above never fires
          // on a gender change). Reconcile to the appearanceKey-preferred
          // texture whenever it differs so the walk sprite always matches
          // `world.playerGender` (mirrors the enemy/NPC late-load reconcile
          // above).
          const preferred = resolvePreferredTexture(visualType, { appearanceKey });
          if (img.texture.key !== preferred.key) {
            img.setTexture(preferred.key, preferred.frame);
            visual.baseScale = resolveBaseScale(img, preferred);
            img.setScale(visual.baseScale);
            if (
              generatedAnimationByTexture.has(preferred.key) &&
              (img as Partial<Phaser.GameObjects.Sprite>).anims === undefined &&
              typeof scene.add.sprite === 'function'
            ) {
              // The cached visual was created as a plain Image (no `.anims` —
              // no walk animation was registered for its texture at creation
              // time), but the reconciled texture DOES have one. An Image can
              // never play a Phaser animation, so recreate it as a Sprite in
              // place (mirrors the `hasWalkAnimation` branch above).
              const { x: px, y: py, flipX: savedFlipX } = img;
              img.destroy();
              const sprite =
                preferred.frame !== undefined
                  ? scene.add.sprite(px, py, preferred.key, preferred.frame)
                  : scene.add.sprite(px, py, preferred.key);
              const spriteBaseScale = resolveBaseScale(sprite, preferred);
              sprite.setScale(spriteBaseScale);
              if (savedFlipX) sprite.setFlipX(true);
              visual = {
                obj: sprite,
                type: visualType,
                baseScale: spriteBaseScale,
                baseScaleRegistryRevision: registryRevision,
              };
              visuals.set(eid, visual);
              img = sprite;
            }
          }
        }
        let isVisible = true;
        if (entityType === 'enemy' && world.floorMap) {
          // Use tile-level visibility (any quarter lit) to stay consistent with
          // weaponSystem and AI perception — avoids "invisible but targetable" paradox.
          const tile = world.floorMap.worldToTile(position.x[eid] ?? 0, position.y[eid] ?? 0);
          isVisible = world.floorMap.isVisible(tile.x, tile.y);
          if (!isVisible && world.debugFlags.showAllRooms) {
            // Debug: show enemies in closed rooms dimly — does NOT affect game FOV
            img.setVisible(true);
            img.setAlpha(0.3);
          } else {
            img.setAlpha(1);
            img.setVisible(isVisible);
          }
        } else {
          img.setAlpha(1);
          img.setVisible(isVisible);
        }
        img.setPosition(x, y);
        const enemyVisibilityAlpha = entityType === 'enemy' ? img.alpha : 1;

        const isDeadEnemy = entityType === 'enemy' && hasComponent(world.ecs, eid, DeathTimer);
        // Decay state for a dead enemy's corpse, applied AFTER the per-type
        // switch below (whose default branch resets alpha/scale for the living).
        let corpseDecay: CorpseDecay | undefined;
        let deathMarker = deathMarkers.get(eid);
        if (isDeadEnemy) {
          const remainingMs = world.stores.deathTimer.remainingMs[eid] ?? 0;
          // Capture the linger duration on the first dead frame so the fade is
          // normalised regardless of the configured deathLingerMs.
          if (visual.deathTotalMs === undefined) {
            visual.deathTotalMs = Math.max(remainingMs, 1);
          }
          corpseDecay = computeCorpseDecay(remainingMs, visual.deathTotalMs);

          if (!deathMarker) {
            const tex = resolveTexture(scene, 'dead_skull');
            deathMarker = scene.add.image(x, y - DEAD_SKULL_Y_OFFSET, tex.key, tex.frame);
            deathMarkers.set(eid, deathMarker);
          }
          // Skull is a brief "soul leaving" beat: it floats up and fades out
          // within ~1s, well before the corpse finishes decaying.
          deathMarker.setVisible(isVisible && corpseDecay.skullAlpha > 0.01);
          deathMarker.setPosition(x, y - DEAD_SKULL_Y_OFFSET - corpseDecay.skullRisePx);
          deathMarker.setAlpha(corpseDecay.skullAlpha);
        } else if (deathMarker) {
          deathMarker.setVisible(false);
        }

        let mobMotion: MobMotionTransform = NEUTRAL_MOB_MOTION;
        let speedStatusActive = false;
        if (entityType === 'enemy' && !isDeadEnemy) {
          const profile = resolveMobMotionProfile(world, eid);
          const state = profile
            ? ensureMobMotionState(eid, world.stores.enemyBehavior.lastFireMs[eid] ?? 0)
            : undefined;
          if (profile && state) {
            const currentLastFireMs = world.stores.enemyBehavior.lastFireMs[eid] ?? 0;
            if (currentLastFireMs !== state.lastFireMs) {
              if (currentLastFireMs > 0) state.releaseAtMs = currentLastFireMs;
              state.lastFireMs = currentLastFireMs;
            }

            const spawnElapsedMs = renderElapsedMs - state.firstSeenMs;
            if (spawnElapsedMs < state.spawnAnimDurationMs) {
              mobMotion = sampleSpawnMotion(spawnElapsedMs);
              if (hasComponent(world.ecs, eid, SpawnAnim)) {
                mobMotion = { ...mobMotion, scaleX: 1, scaleY: 1 };
              }
            } else if (
              state.hitAtMs !== undefined &&
              renderElapsedMs - state.hitAtMs < HIT_REACTION_MOTION_MS
            ) {
              mobMotion = sampleHitReactionMotion(renderElapsedMs - state.hitAtMs);
            } else if (
              state.contactAtMs !== undefined &&
              renderElapsedMs - state.contactAtMs < CONTACT_ATTACK_MOTION_MS
            ) {
              mobMotion = sampleContactAttackMotion(renderElapsedMs - state.contactAtMs);
            } else if (isEnemyProjectileTelegraphActive(world, eid)) {
              const startMs = world.stores.enemyBehavior.telegraphStartMs[eid] ?? renderElapsedMs;
              const delayMs = Math.max(1, world.stores.enemyBehavior.telegraphDelayMs[eid] ?? 1);
              mobMotion = sampleRangedWindupMotion((renderElapsedMs - startMs) / delayMs);
            } else if (
              state.releaseAtMs !== undefined &&
              renderElapsedMs - state.releaseAtMs < RANGED_RELEASE_MOTION_MS
            ) {
              mobMotion = sampleRangedReleaseMotion(renderElapsedMs - state.releaseAtMs);
            } else if (
              (velocity.x[eid] ?? 0) ** 2 + (velocity.y[eid] ?? 0) ** 2 >
              ENEMY_MOVEMENT_MOTION_EPSILON_SQ
            ) {
              mobMotion = sampleMovementMotion(renderElapsedMs, profile.movementStyle);
            }

            speedStatusActive = hasActiveSpeedStatus(world, eid);
            if (speedStatusActive) {
              mobMotion = combineMobMotion(mobMotion, sampleSpeedStatusMotion(renderElapsedMs));
            }
          }
        }

        // Per-type updates
        switch (entityType) {
          case 'proj':
          case 'enemy_proj': {
            const vx = velocity.x[eid] ?? 0;
            const vy = velocity.y[eid] ?? 0;
            if (Math.abs(vx) > 0.001 || Math.abs(vy) > 0.001) {
              img.setRotation(Math.atan2(vy, vx) + Math.PI / 2);
            }
            break;
          }

          case 'aoe_proj':
          case 'enemy_aoe_proj': {
            // Fireball/acid ball: gentle pulsing glow
            const pulse = 0.9 + 0.2 * Math.sin(renderElapsedMs * 0.01);
            img.setScale(pulse);
            const vx = velocity.x[eid] ?? 0;
            const vy = velocity.y[eid] ?? 0;
            if (Math.abs(vx) > 0.001 || Math.abs(vy) > 0.001) {
              img.setRotation(Math.atan2(vy, vx) + Math.PI / 2);
            }
            break;
          }

          case 'returning': {
            // Spinning rotation
            img.setRotation(renderElapsedMs * 0.015);
            break;
          }

          case 'aoe':
          case 'enemy_aoe': {
            const radius = ftToPx(areaDamage.radius[eid] ?? 4);
            const arcHalf = areaDamage.arcHalfRad[eid] ?? 0;
            const arcCenter = areaDamage.arcCenterRad[eid] ?? 0;
            const isArc = arcHalf > 0 && arcHalf < Math.PI;

            // Fade out based on lifetime
            const expiresAt = lifetime.expiresAtMs[eid] ?? 0;
            const remaining = Math.max(0, expiresAt - renderElapsedMs);
            const alpha = Math.min(1, remaining / 100);

            if (isArc) {
              // Render as an animated sweeping blade line
              img.setVisible(false);
              let ag = arcGraphics.get(eid);
              if (!ag) {
                ag = scene.add.graphics();
                arcGraphics.set(eid, ag);
                arcSpawnMs.set(eid, renderElapsedMs);
              }
              ag.clear();

              // Calculate sweep progress (0→1 over the swing duration)
              const spawnTime = arcSpawnMs.get(eid) ?? renderElapsedMs;
              const expiresAt = lifetime.expiresAtMs[eid] ?? 0;
              const totalDuration = Math.max(1, expiresAt - spawnTime);
              const elapsed = renderElapsedMs - spawnTime;
              const progress = Math.min(1, Math.max(0, elapsed / totalDuration));

              // Sweep from start angle to end angle (right-to-left)
              const startAngle = arcCenter + arcHalf;
              const endAngle = arcCenter - arcHalf;
              const currentAngle = startAngle + (endAngle - startAngle) * progress;

              const tipX = x + Math.cos(currentAngle) * radius;
              const tipY = y + Math.sin(currentAngle) * radius;

              // Blade line
              ag.lineStyle(3, 0xcccccc, alpha);
              ag.beginPath();
              ag.moveTo(x, y);
              ag.lineTo(tipX, tipY);
              ag.strokePath();

              // Bright tip
              ag.fillStyle(0xffffff, alpha);
              ag.fillCircle(tipX, tipY, 3);

              // Faint trail arc showing the swept area
              if (progress > 0.05) {
                const sweptStart = startAngle;
                const sweptEnd = currentAngle;
                ag.lineStyle(1, 0xffffaa, 0.15 * alpha);
                ag.beginPath();
                ag.arc(x, y, radius, sweptStart, sweptEnd, startAngle > endAngle);
                ag.strokePath();
              }
            } else {
              // Full circle AoE — use image
              const currentTex = resolveTexture(
                scene,
                entityType === 'enemy_aoe' ? 'melee' : 'aoe_proj',
              );
              let scale = (radius * 2) / (currentTex.scale > 1 ? 16 : 66);
              img.setScale(scale);
              img.setAlpha(alpha);

              // Use explosion texture for trap-spawned AoEs (short duration)
              const explosionType = entityType === 'enemy_aoe' ? 'enemy_explosion' : 'explosion';
              const explosionTex = resolveTexture(scene, explosionType);
              if (remaining <= 100 && img.texture.key !== explosionTex.key) {
                img.setTexture(explosionTex.key, explosionTex.frame);
                // Recalculate scale based on new texture
                scale = (radius * 2) / (explosionTex.scale > 1 ? 16 : 66);
                img.setScale(scale);
              }

              // Clean up any stale arc graphics
              const staleAg = arcGraphics.get(eid);
              if (staleAg) {
                staleAg.destroy();
                arcGraphics.delete(eid);
                arcSpawnMs.delete(eid);
              }
            }
            break;
          }

          case 'trap': {
            // Switch texture based on arm state
            const armAt = trap.armAtMs[eid] ?? 0;
            const isArmed = renderElapsedMs >= armAt;
            const tex = resolveTexture(scene, isArmed ? 'trap_armed' : 'trap_arming');
            img.setTexture(tex.key, tex.frame);

            // Pulse when armed
            if (isArmed) {
              const pulse = 0.8 + 0.3 * Math.sin(renderElapsedMs * 0.008);
              img.setAlpha(pulse);
            } else {
              // Arming blink
              const blink = Math.sin(renderElapsedMs * 0.02) > 0 ? 0.7 : 0.3;
              img.setAlpha(blink);
            }
            break;
          }

          case 'welcome_sign': {
            const angle = hasComponent(world.ecs, eid, Rotation)
              ? (world.stores.rotation.angle[eid] ?? 0)
              : 0;
            // Past vertical (left hemisphere, cos < 0) the arrow-right board
            // would render "WELCOME" upside-down, so swap to the arrow-left board
            // and measure rotation from the −x reference. The word then stays
            // within ±90° of upright while the arrow still points along `angle`.
            const facing: 'left' | 'right' = Math.cos(angle) < 0 ? 'left' : 'right';
            if (visual.welcomeFacing !== facing) {
              img.setTexture(facing === 'left' ? TEX_WELCOME_SIGN_LEFT : TEX_WELCOME_SIGN);
              visual.welcomeFacing = facing;
            }
            img.setRotation(facing === 'left' ? angle - Math.PI : angle);
            break;
          }

          case 'gem': {
            // Floating bob: sine-wave offset so each gem feels alive. Phase
            // offset by eid so nearby gems bob out of sync with each other.
            if (!gemSpawnMs.has(eid)) {
              gemSpawnMs.set(eid, renderElapsedMs);
              // Create a faint ground shadow once on first sight (guarded so
              // test environments without Phaser ellipse support still work).
              if (typeof scene.add.ellipse === 'function') {
                const shadow = scene.add.ellipse(x, y + 10, 18, 6, 0x000000, 0.28);
                shadow.setDepth(img.depth - 1);
                gemShadows.set(eid, shadow);
              }
            }
            const phaseOffset = (eid % 13) * 0.48;
            const elapsed = renderElapsedMs - (gemSpawnMs.get(eid) ?? renderElapsedMs);
            const bob = Math.sin(elapsed * 0.007 + phaseOffset) * 5;
            img.setPosition(x, y + bob);
            img.setAlpha(1);
            img.setScale(visual.baseScale);
            // Keep shadow pinned to the ground under the bobbing gem.
            const shadow = gemShadows.get(eid);
            if (shadow) {
              shadow.setPosition(x, y + 10);
            }
            break;
          }

          case 'gold': {
            // Bobbing coin drop: same sine-wave pattern as gems but slightly
            // faster and smaller amplitude so coins feel lighter than crystals.
            if (!goldSpawnMs.has(eid)) {
              goldSpawnMs.set(eid, renderElapsedMs);
              if (typeof scene.add.ellipse === 'function') {
                const shadow = scene.add.ellipse(x, y + 9, 14, 5, 0x000000, 0.25);
                shadow.setDepth(img.depth - 1);
                goldShadows.set(eid, shadow);
              }
            }
            const phaseOffset = (eid % 11) * 0.57;
            const elapsed = renderElapsedMs - (goldSpawnMs.get(eid) ?? renderElapsedMs);
            const bob = Math.sin(elapsed * 0.009 + phaseOffset) * 4;
            img.setPosition(x, y + bob);
            img.setAlpha(1);
            img.setScale(visual.baseScale);
            const shadow = goldShadows.get(eid);
            if (shadow) {
              shadow.setPosition(x, y + 9);
            }
            break;
          }

          default:
            img.setAlpha(1);
            img.setRotation(0);
            if (entityType === 'enemy') {
              const { scaleX, scaleY } = computeEnemyScale(world, eid, visual.baseScale);
              const movingRight = (velocity.x[eid] ?? 0) > ENEMY_RIGHTWARD_FLIP_EPSILON;
              const baseFacing = generatedFacingByTexture.get(img.texture.key) ?? 'right';
              const shouldMirror = baseFacing === 'right' ? !movingRight : movingRight;
              const signedOffsetX = shouldMirror ? -mobMotion.offsetX : mobMotion.offsetX;
              const signedRotation = shouldMirror ? -mobMotion.rotation : mobMotion.rotation;
              img.setPosition(x + ftToPx(signedOffsetX), y + ftToPx(mobMotion.offsetY));
              img.setScale(
                Math.abs(scaleX) * mobMotion.scaleX,
                Math.abs(scaleY) * mobMotion.scaleY,
              );
              img.setRotation(signedRotation);
              img.setAlpha(enemyVisibilityAlpha * mobMotion.alpha);
              if (typeof img.setFlipX === 'function') {
                img.setFlipX(shouldMirror);
              }
            } else {
              img.setScale(visual.baseScale);
              if (entityType === 'player') {
                // Unlike the enemy branch (which is nearly always moving toward a
                // target), the player frequently has vx === 0 — standing still, or
                // walking straight up/down. Only re-derive facing when there is a
                // clear horizontal velocity signal; otherwise keep the sprite's
                // current flip so the player doesn't snap to "face left" every
                // time they stop or move vertically.
                const vx = velocity.x[eid] ?? 0;
                if (Math.abs(vx) > ENEMY_RIGHTWARD_FLIP_EPSILON) {
                  const movingRight = vx > 0;
                  playerFacingRightByEid.set(eid, movingRight);
                  const baseFacing = generatedFacingByTexture.get(img.texture.key) ?? 'right';
                  const shouldMirror = baseFacing === 'right' ? !movingRight : movingRight;
                  if (typeof img.setFlipX === 'function') {
                    img.setFlipX(shouldMirror);
                  }
                }
                playPlayerWalkAnimation(img, eid);
                // The equipped main-hand weapon is always carried, not just
                // drawn for the duration of a swing.
                updateCarriedWeapon(eid, x, y, img.visible !== false);
              } else if (entityType !== 'npc' && typeof img.setFlipX === 'function') {
                img.setFlipX(false);
              }
            }
            break;
        }

        if (entityType === 'npc') {
          const npcInstance = world.npcs.get(eid);
          const npcWidthFt = world.stores.sprite.width[eid] ?? 0;
          const npcHeightFt = world.stores.sprite.height[eid] ?? 0;
          if (Number.isFinite(npcHeightFt) && npcHeightFt > 0) {
            // Height-authoritative, aspect-preserving — same rule as set-piece
            // props. `setDisplaySize` used to STRETCH the character into the
            // declared box, so a 5.71x5 ft anchor on a square portrait sprite
            // squashed the NPC 14% wide AND capped its apparent height below the
            // authored feet. `heightFt` is the human yardstick every prop is
            // scaled against, so it must survive verbatim.
            const nativeH = img.height;
            if (nativeH > 0 && typeof img.setScale === 'function') {
              img.setScale(ftToPx(npcHeightFt) / nativeH);
            } else if (
              Number.isFinite(npcWidthFt) &&
              npcWidthFt > 0 &&
              typeof img.setDisplaySize === 'function'
            ) {
              img.setDisplaySize(ftToPx(npcWidthFt), ftToPx(npcHeightFt));
            }
          }
          if (typeof img.setDepth === 'function') {
            if (Number.isFinite(npcInstance?.z ?? NaN) && npcInstance?.z !== undefined) {
              img.setDepth(Math.max(TERRAIN_DEPTH + 0.001, setPieceZToDepth(npcInstance.z)));
            } else {
              img.setDepth(ENTITY_DEPTH);
            }
          }
          if (typeof img.setFlipX === 'function') {
            img.setFlipX(npcInstance?.flipX === true);
          }
          if (typeof img.setFlipY === 'function') {
            img.setFlipY(npcInstance?.flipY === true);
          }
          if (typeof img.setAngle === 'function') {
            img.setAngle(
              Number.isFinite(npcInstance?.rotationDeg ?? NaN)
                ? (npcInstance?.rotationDeg ?? 0)
                : 0,
            );
          }
        }

        // Corpse styling wins over the per-type switch: a dead enemy drains
        // toward grey (multiply tint) and fades out across its linger window.
        if (corpseDecay) {
          if (typeof img.setTint === 'function') {
            img.setTint(corpseDecay.tint);
          }
          img.setAlpha(corpseDecay.corpseAlpha);
          // Corpses render on the ground plane (below the player and living
          // enemies at the default depth of 0) so the player is never buried
          // under a fresh kill. Sits ABOVE `bloodPool` so the corpse still
          // reads as lying inside the pool it bled into.
          img.setDepth(WORLD_VFX_DEPTH.corpse);
        } else if (visual.deathTotalMs !== undefined) {
          // This visual previously backed a corpse but its EID has been
          // recycled for a living entity (bitecs reuses freed EIDs). Clear the
          // leftover grey multiply-tint and stale linger duration so the reused
          // sprite renders normally and recalibrates cleanly on its next death.
          if (typeof img.clearTint === 'function') {
            img.clearTint();
          }
          // Also reset the corpse depth we set during the dead phase so the
          // recycled sprite renders at the default entity plane again.
          img.setDepth(ENTITY_DEPTH);
          visual.deathTotalMs = undefined;
        }

        // Enemy tint policy from live identity: unwired spawners stay red,
        // then Rat Brute dark-grey. Dedicated spawner art opts out of the red wash.
        if (entityType === 'enemy' && !corpseDecay) {
          const identityTint = enemyAppearanceTint(world.ecs, eid, appearanceKey, visualType);
          let tint = identityTint ?? 0xffffff;
          if (speedStatusActive) tint = multiplyTint(tint, SPEED_STATUS_TINT);
          if (tint !== 0xffffff && typeof img.setTint === 'function') {
            img.setTint(tint);
          } else if (typeof img.clearTint === 'function') {
            img.clearTint();
          }
        }

        if (entityType === 'enemy') {
          let flashOverlay = mobFlashOverlays.get(eid);
          if (!corpseDecay && mobMotion.flash > 0) {
            const frame = img.frame?.name;
            if (!flashOverlay) {
              flashOverlay = scene.add.image(img.x, img.y, img.texture.key, frame);
              flashOverlay.setTint(0xffffff).setTintMode(PHASER_TINT_MODE_FILL);
              (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(
                flashOverlay,
              );
              mobFlashOverlays.set(eid, flashOverlay);
            } else if (
              flashOverlay.texture.key !== img.texture.key ||
              String(flashOverlay.frame?.name) !== String(frame)
            ) {
              flashOverlay.setTexture(img.texture.key, frame);
            }
            flashOverlay
              .setOrigin(img.originX, img.originY)
              .setPosition(img.x, img.y)
              .setScale(img.scaleX, img.scaleY)
              .setRotation(img.rotation)
              .setFlipX(img.flipX)
              .setFlipY(img.flipY)
              .setDepth(img.depth + 0.001)
              .setAlpha(img.alpha * mobMotion.flash)
              .setVisible(img.visible);
          } else {
            flashOverlay?.setVisible(false);
          }

          const shouldShowMobHealthBar =
            !isBoss && !isDeadEnemy && isVisible && typeof scene.add.graphics === 'function';
          const existingBar = mobHealthBars.get(eid);
          if (!shouldShowMobHealthBar) {
            existingBar?.setVisible(false);
          } else {
            const current = Math.max(0, world.stores.health.current[eid] ?? 0);
            const max = Math.max(1, world.stores.health.max[eid] ?? 1);
            const pct = Math.max(0, Math.min(1, current / max));
            const displayWidth =
              typeof img.displayWidth === 'number' && Number.isFinite(img.displayWidth)
                ? img.displayWidth
                : MOB_HEALTH_BAR_MIN_WIDTH_PX;
            const displayHeight =
              typeof img.displayHeight === 'number' && Number.isFinite(img.displayHeight)
                ? img.displayHeight
                : MOB_HEALTH_BAR_DEFAULT_SPRITE_HALF_HEIGHT_PX * 2;
            const barWidth = Math.max(
              MOB_HEALTH_BAR_MIN_WIDTH_PX,
              Math.min(MOB_HEALTH_BAR_MAX_WIDTH_PX, Math.round(displayWidth)),
            );
            const barX = x - barWidth / 2;
            const barY = y + displayHeight / 2 + MOB_HEALTH_BAR_Y_GAP_PX;
            const fillWidth = Math.max(0, Math.round(barWidth * pct));
            const fillColor =
              pct > 0.5
                ? BOSS_BAR_COLORS.high
                : pct >= 0.25
                  ? BOSS_BAR_COLORS.mid
                  : BOSS_BAR_COLORS.low;
            const bar = existingBar ?? scene.add.graphics();
            if (!existingBar) {
              mobHealthBars.set(eid, bar);
            }
            bar
              .setDepth((img.depth ?? 0) + 1)
              .setVisible(true)
              .setAlpha(img.alpha ?? 1);
            bar.clear();
            bar.fillStyle(0x111827, 0.9);
            bar.fillRect(barX - 1, barY - 1, barWidth + 2, MOB_HEALTH_BAR_HEIGHT_PX + 2);
            if (fillWidth > 0) {
              bar.fillStyle(fillColor, 1);
              bar.fillRect(barX, barY, fillWidth, MOB_HEALTH_BAR_HEIGHT_PX);
            }
            bar.lineStyle(1, 0x000000, 1);
            bar.strokeRect(barX - 1, barY - 1, barWidth + 2, MOB_HEALTH_BAR_HEIGHT_PX + 2);
          }

          // --- Locked-trajectory telegraph cue ---
          // Reads the SAME locked origin/direction fields the fire logic and
          // AI dodge reasoning use (core/systems/enemyTelegraph.ts) — never
          // live position — so what the player sees is exactly what will fire.
          // Gated on the same `isVisible` FOV check as the sprite/health bar:
          // an off-screen/fog-hidden shooter must not reveal its position or
          // aim line through the telegraph cue. The AI's dodge reasoning is
          // gated the same way (via `canCurrentlyPerceiveWorldPosition()` at
          // the shooter's live position, in bt-ai-provider.ts) so both paths
          // share the same no-privileged-visibility contract.
          // Also gated on `!isDeadEnemy`: damage/drop/death processing runs
          // after enemy AI, and this render pass runs after that, so a
          // shooter killed earlier this same frame can still have
          // `telegraphActive` set until the NEXT enemyAISystem pass cancels
          // it — without this guard the cue would draw from a corpse.
          //
          // The `telegraphWasActiveThisFrame` sticky flag handles the 16×
          // AI-runner-lab playback case: at high simulation speeds the
          // catch-up loop can run many sim steps per rendered frame, so a
          // short telegraph (e.g. 250ms default delay at 16× = only ~1 sim
          // step) can start AND complete within a single batch, meaning
          // `telegraphActive` flips 0→1→0 before the next sync(). The sticky
          // flag is set once by `startEnemyProjectileTelegraph()` and cleared
          // here (after rendering) so the cue is visible for exactly one
          // rendered frame even when `telegraphActive` is already 0 at sync
          // time. Production (1× speed) is unaffected: every step is followed
          // by a sync, so `telegraphActive` alone is sufficient.
          const { enemyBehavior: eb } = world.stores;
          const isTelegraphing =
            (isEnemyProjectileTelegraphActive(world, eid) ||
              eb.telegraphWasActiveThisFrame[eid] === 1) &&
            isVisible &&
            !isDeadEnemy;
          const existingTelegraph = telegraphGraphics.get(eid);
          if (!isTelegraphing) {
            existingTelegraph?.setVisible(false);
          } else if (typeof scene.add.graphics === 'function') {
            const enemyBehaviorStore = world.stores.enemyBehavior;
            const startMs = enemyBehaviorStore.telegraphStartMs[eid] ?? 0;
            const delayMs = Math.max(1, enemyBehaviorStore.telegraphDelayMs[eid] ?? 1);
            const elapsedMs = Math.max(0, renderElapsedMs - startMs);
            const progress = Math.min(1, elapsedMs / delayMs);
            const originX = ftToPx(enemyBehaviorStore.telegraphOriginX[eid] ?? 0);
            const originY = ftToPx(enemyBehaviorStore.telegraphOriginY[eid] ?? 0);
            const dirX = enemyBehaviorStore.telegraphDirX[eid] ?? 0;
            const dirY = enemyBehaviorStore.telegraphDirY[eid] ?? 0;
            const rangeFt = Math.max(1, enemyBehaviorStore.attackRange[eid] ?? 1);
            const length = ftToPx(rangeFt);
            // Pulses faster as the shot nears firing so the cue reads as an
            // urgency ramp, not a static line. Phased on this telegraph's own
            // `elapsedMs` (not the absolute/global `renderElapsedMs`) so the
            // pulse frequency change from `progress` doesn't cause the sine
            // phase to jump — an absolute-time phase combined with a
            // progress-dependent frequency produces a phase discontinuity
            // every frame once the game has been running a while, which
            // reads as random high-frequency flicker instead of a smooth
            // urgency ramp.
            const pulse = 0.55 + 0.45 * Math.sin(elapsedMs * (0.006 + progress * 0.02));
            const alpha = (0.35 + 0.5 * progress) * pulse;

            const tg = existingTelegraph ?? scene.add.graphics();
            if (!existingTelegraph) {
              telegraphGraphics.set(eid, tg);
            }
            tg.setDepth((img.depth ?? 0) + 1).setVisible(true);
            tg.clear();
            tg.lineStyle(2, 0xff2222, alpha);
            tg.beginPath();
            tg.moveTo(originX, originY);
            tg.lineTo(originX + dirX * length, originY + dirY * length);
            tg.strokePath();
            // Origin marker so the locked shooter position reads clearly even
            // if the enemy's sprite has visually drifted (e.g. from a knockback
            // that intentionally does not un-lock the telegraph — see
            // enemyTelegraph.ts).
            tg.fillStyle(0xff2222, Math.min(1, alpha + 0.15));
            tg.fillCircle(originX, originY, 4);
          }
          // Clear the per-frame sticky flag after it has been consumed. If the
          // telegraph is still active (`eb.telegraphActive[eid] === 1`) the cue
          // will keep rendering via that flag in future frames; if it completed
          // during the batch, it will have rendered for exactly one frame here
          // and now correctly goes dark.
          eb.telegraphWasActiveThisFrame[eid] = 0;
        }
      }

      // --- Prop render pass ---
      // Render Prop entities as real sprites when a wired spriteId resolves;
      // otherwise fall back to coloured placeholders so unknown props remain visible.
      const activePropEids = new Set<number>();
      for (const propEid of query(world.ecs, [Prop, Position])) {
        activePropEids.add(propEid);
        const propX = ftToPx(position.x[propEid] ?? 0);
        const propY = ftToPx(position.y[propEid] ?? 0);

        const defIdIndex = world.stores.prop.defIdIndex[propEid] ?? 0;
        const defId = DECORATION_INDEX_TO_ID[defIdIndex];
        const decorationDef = defId !== undefined ? getDecorationDef(defId) : undefined;
        // `DecorationDef.scale` is documented as a "size multiplier relative to
        // base (1.0 = 100%)", NOT a feet value — but this line used to feed it
        // straight into `ftToPx()`, so a torch authored at `scale: 1.2` rendered
        // at 1.2 ft (~10 px), comically small next to the 3 ft player. Multiply
        // by a reference footprint (a "normal-sized" prop, matching the
        // `prop-torch` asset brief's "reads clearly at gameplay scale") to
        // restore the intended multiplier semantics.
        const scalePx = ftToPx(_PROP_VISUAL_BASE_SIZE_FT * (decorationDef?.scale ?? 1.0));
        const depth =
          decorationDef?.depthLayer === 'back'
            ? PROP_DEPTH.back
            : decorationDef?.depthLayer === 'front'
              ? PROP_DEPTH.front
              : PROP_DEPTH.mid;
        // Colour by category for easy visual identification in labs.
        const fillColor =
          decorationDef?.category === 'light-source'
            ? 0xffb347
            : decorationDef?.category === 'rubbish'
              ? 0x8b7355
              : 0x6b7280;
        const spriteId = decorationDef?.spriteId;
        const spriteDef = spriteId !== undefined ? getSprite(spriteId) : undefined;
        const hasKenneySprite =
          spriteDef !== undefined && scene.textures?.exists(spriteDef.sheetKey) === true;
        const hasGeneratedSprite =
          spriteId !== undefined && scene.textures?.exists(spriteId) === true;
        const shouldRenderSprite =
          typeof scene.add.image === 'function' && (hasKenneySprite || hasGeneratedSprite);

        let visual = propVisuals.get(propEid);
        if (shouldRenderSprite) {
          const textureKey = hasKenneySprite ? spriteDef!.sheetKey : spriteId!;
          const frame = hasKenneySprite ? spriteDef!.frame : undefined;
          if (visual === undefined || visual.mode !== 'sprite') {
            visual?.obj.destroy();
            const img =
              frame !== undefined
                ? scene.add.image(propX, propY, textureKey, frame)
                : scene.add.image(propX, propY, textureKey);
            img.setOrigin(0.5, 0.5);
            img.setDisplaySize(scalePx, scalePx);
            img.setDepth(depth);
            visual = { obj: img, mode: 'sprite', textureKey, frame };
            propVisuals.set(propEid, visual);
          } else {
            const img = visual.obj as Phaser.GameObjects.Image;
            img.setPosition(propX, propY);
            img.setDisplaySize(scalePx, scalePx);
            img.setDepth(depth);
            const keyChanged = visual.textureKey !== textureKey;
            const frameChanged =
              !keyChanged && frame !== undefined && String(img.frame?.name) !== String(frame);
            if (keyChanged || frameChanged) {
              if (frame !== undefined) {
                img.setTexture(textureKey, frame);
              } else {
                img.setTexture(textureKey);
              }
            }
            visual.textureKey = textureKey;
            visual.frame = frame;
          }
        } else if (typeof scene.add.rectangle === 'function') {
          if (visual === undefined || visual.mode !== 'placeholder') {
            visual?.obj.destroy();
            const rect = scene.add.rectangle(propX, propY, scalePx, scalePx, fillColor, 0.6);
            rect.setDepth(depth);
            visual = { obj: rect, mode: 'placeholder' };
            propVisuals.set(propEid, visual);
          } else {
            const rect = visual.obj as Phaser.GameObjects.Rectangle;
            rect.setPosition(propX, propY);
            rect.setSize(scalePx, scalePx);
            rect.setFillStyle(fillColor, 0.6);
            rect.setDepth(depth);
          }
        }
      }
      // Clean up removed prop visuals.
      for (const [propEid, visual] of propVisuals) {
        if (!activePropEids.has(propEid)) {
          visual.obj.destroy();
          propVisuals.delete(propEid);
        }
      }

      // --- Set-piece prop render pass ---
      // Render-only set-piece prop layers (rugs, banners, desks, bookcases) live
      // on `world.setPieceProps` as plain instances — NOT entities — so they
      // consume no entity ids and never perturb gameplay. Keyed here by list
      // index. Each resolves its own sprite/depth/footprint and STRADDLES the
      // entity plane via its precomputed depth (rug under the NPC, desk in front).
      const setPieceProps = world.setPieceProps;
      for (let i = 0; i < setPieceProps.length; i++) {
        const instance = setPieceProps[i];
        if (instance === undefined) {
          continue;
        }
        const sp = instance.render;
        const propX = ftToPx(instance.x);
        const propY = ftToPx(instance.y);
        const spScale = sp.scale ?? 1;
        const spWidthPx = ftToPx(sp.widthFt * spScale);
        const spHeightPx = ftToPx(sp.heightFt * spScale);
        const spDepth = sp.depth;
        const spTint = hexToTintInt(sp.tintHex);
        const resolved = resolveSetPieceSprite(scene, sp.sprite);
        let visual = setPiecePropVisuals.get(i);
        if (resolved !== null && typeof scene.add.image === 'function') {
          const { textureKey, frame } = resolved;
          if (visual === undefined || visual.mode !== 'sprite') {
            visual?.obj.destroy();
            const img =
              frame !== undefined
                ? scene.add.image(propX, propY, textureKey, frame)
                : scene.add.image(propX, propY, textureKey);
            img.setOrigin(0.5, 0.5);
            visual = { obj: img, mode: 'sprite', textureKey, frame };
            setPiecePropVisuals.set(i, visual);
          }
          const img = visual.obj as Phaser.GameObjects.Image;
          const keyChanged = visual.textureKey !== textureKey;
          const frameChanged =
            !keyChanged && frame !== undefined && String(img.frame?.name) !== String(frame);
          if (keyChanged || frameChanged) {
            if (frame !== undefined) {
              img.setTexture(textureKey, frame);
            } else {
              img.setTexture(textureKey);
            }
          }
          img.setPosition(propX, propY);
          // Anchor + scale are both resolved against the sprite's OPAQUE pixel
          // bounds, not its raw canvas. The pipeline ships a standardized ~5%
          // per-side transparent safety margin, so measuring against the canvas
          // (a) pins `anchorBase` props by the canvas bottom rather than the
          // object's feet — they floated up to 0.42 ft above their floor line —
          // and (b) makes `heightFt` scale padding-plus-art, rendering every
          // prop ~10% shorter than its declared feet.
          //
          // `heightFt` stays AUTHORITATIVE for upright props: the sprite is
          // scaled so its apparent vertical height matches the declared feet and
          // its width follows the art's own aspect. We do NOT contain-fit
          // upright props, because `Math.min` silently discards whichever
          // declared dimension is the looser fit: a torch authored at 1.5x3 ft
          // against a square 64x64 canvas rendered at 1.5 ft, throwing away HALF
          // its height. 13 of the welcome room's 31 props were losing 5-50% of
          // their authored height that way, which is what made every room read
          // as squashed.
          //
          // Floor decals (rugs, stains, tape) are the exception: they lie IN the
          // floor plane, so both declared feet are real ground extents and must
          // both be honoured. Those keep the aspect-preserving contain-fit.
          //
          // `resolveOpaqueFit` degrades to whole-canvas behaviour when the
          // manifest has no bounds (legacy entries) or they disagree with the
          // loaded texture, so stale data reverts to the old look, not garbage.
          const nativeW = img.width;
          const nativeH = img.height;
          if (nativeW > 0 && nativeH > 0) {
            const fit = resolveOpaqueFit({
              bounds: generatedBoundsByTexture.get(textureKey),
              canvasWidth: nativeW,
              canvasHeight: nativeH,
              targetWidthPx: spWidthPx,
              targetHeightPx: spHeightPx,
              anchorBase: sp.anchorBase === true,
              floorPlane: sp.floorPlane === true,
            });
            // Set every frame: a visual is reused by list index, so a prop may
            // change its anchor or art on a room reset.
            if (typeof img.setOrigin === 'function') {
              img.setOrigin(fit.originX, fit.originY);
            }
            img.setScale(fit.scale);
          } else {
            if (typeof img.setOrigin === 'function') {
              img.setOrigin(0.5, sp.anchorBase === true ? 1 : 0.5);
            }
            img.setDisplaySize(spWidthPx, spHeightPx);
          }
          // Mirror the sprite when the layer requests it (e.g. a right-side wall
          // sconce reuses the single approved variant via flipX). Guarded like
          // the entity path above so a mock/object without the flip API is safe.
          if (typeof img.setFlipX === 'function') {
            img.setFlipX(sp.flipX === true);
          }
          if (typeof img.setFlipY === 'function') {
            img.setFlipY(sp.flipY === true);
          }
          if (typeof img.setAngle === 'function') {
            img.setAngle(Number.isFinite(sp.rotationDeg) ? sp.rotationDeg : 0);
          }
          img.setDepth(spDepth);
          if (spTint !== undefined) {
            img.setTint(spTint);
          } else {
            img.clearTint();
          }
          visual.textureKey = textureKey;
          visual.frame = frame;
        } else if (typeof scene.add.rectangle === 'function') {
          // No loaded art yet: draw a tinted placeholder box so the prop is visible.
          const fill = spTint ?? 0x6b7280;
          if (visual === undefined || visual.mode !== 'placeholder') {
            visual?.obj.destroy();
            const rect = scene.add.rectangle(propX, propY, spWidthPx, spHeightPx, fill, 0.6);
            visual = { obj: rect, mode: 'placeholder' };
            setPiecePropVisuals.set(i, visual);
          }
          const rect = visual.obj as Phaser.GameObjects.Rectangle;
          rect.setPosition(propX, propY);
          rect.setSize(spWidthPx, spHeightPx);
          rect.setFillStyle(fill, 0.6);
          rect.setDepth(spDepth);
        }
      }
      // Evict set-piece visuals whose index no longer exists (a floor reset
      // rebuilt `world.setPieceProps` with fewer layers).
      for (const [index, visual] of setPiecePropVisuals) {
        if (index >= setPieceProps.length) {
          visual.obj.destroy();
          setPiecePropVisuals.delete(index);
        }
      }

      // Clean up removed entities
      for (const [eid, visual] of visuals) {
        if (activeEntities.has(eid)) {
          continue;
        }
        visual.obj.destroy();
        visuals.delete(eid);
        playerWalkMovingByEid.delete(eid);
        acceptedStepDisplacementByEid.delete(eid);
        playerFacingRightByEid.delete(eid);
        const carriedWeapon = carriedWeaponVisuals.get(eid);
        if (carriedWeapon) {
          carriedWeapon.destroy();
          carriedWeaponVisuals.delete(eid);
        }
        // Remove weapon anchor so dead/despawned entities don't leave stale
        // offsets that could be picked up if the eid is reused later.
        world.entityWeaponAnchors.delete(eid);
      }

      for (const [eid, marker] of deathMarkers) {
        if (activeEntities.has(eid)) {
          continue;
        }
        marker.destroy();
        deathMarkers.delete(eid);
      }

      for (const [eid, bg] of beamGraphics) {
        if (activeEntities.has(eid)) {
          continue;
        }
        bg.destroy();
        beamGraphics.delete(eid);
      }

      for (const [eid, ag] of arcGraphics) {
        if (activeEntities.has(eid)) {
          continue;
        }
        ag.destroy();
        arcGraphics.delete(eid);
        arcSpawnMs.delete(eid);
      }

      for (const [eid, hg] of harvestNodeGraphics) {
        if (activeEntities.has(eid)) {
          continue;
        }
        hg.destroy();
        harvestNodeGraphics.delete(eid);
      }

      for (const [eid, img] of harvestNodeImages) {
        if (activeEntities.has(eid)) {
          continue;
        }
        img.destroy();
        harvestNodeImages.delete(eid);
      }

      for (const [eid, bar] of mobHealthBars) {
        if (activeEntities.has(eid)) {
          continue;
        }
        bar.destroy();
        mobHealthBars.delete(eid);
      }

      for (const [eid, tg] of telegraphGraphics) {
        // Beyond the usual active-entity liveness check, also require the
        // EID to still resolve as an enemy: bitecs may recycle a removed
        // enemy's EID for an unrelated sprite (e.g. a gem/prop) across a
        // batch of simulation steps that runs before the next render, and
        // `activeEntities` alone can't distinguish "same enemy, still alive"
        // from "different entity now occupying this recycled EID" — without
        // this check the old aim line would keep rendering indefinitely,
        // now pinned to the wrong entity's position.
        if (activeEntities.has(eid) && resolveRenderKind(world, eid) === 'enemy') {
          continue;
        }
        tg.destroy();
        telegraphGraphics.delete(eid);
      }

      for (const [eid] of mobMotionStates) {
        if (
          activeEntities.has(eid) &&
          resolveRenderKind(world, eid) === 'enemy' &&
          resolveMobMotionProfile(world, eid)
        ) {
          continue;
        }
        mobMotionStates.delete(eid);
      }

      for (const [eid, overlay] of mobFlashOverlays) {
        if (
          activeEntities.has(eid) &&
          resolveRenderKind(world, eid) === 'enemy' &&
          resolveMobMotionProfile(world, eid)
        ) {
          continue;
        }
        overlay.destroy();
        mobFlashOverlays.delete(eid);
      }

      // Iterate the spawn-time maps (always populated on first sight), not the
      // shadow maps (only populated when the scene supports add.ellipse), so
      // gem/gold entities clean up even in headless/test render paths that never
      // create a ground shadow. Destroy the shadow only if one exists.
      for (const [eid] of gemSpawnMs) {
        if (activeEntities.has(eid)) {
          continue;
        }
        gemShadows.get(eid)?.destroy();
        gemShadows.delete(eid);
        gemSpawnMs.delete(eid);
      }

      for (const [eid] of goldSpawnMs) {
        if (activeEntities.has(eid)) {
          continue;
        }
        goldShadows.get(eid)?.destroy();
        goldShadows.delete(eid);
        goldSpawnMs.delete(eid);
      }

      const deltaMs =
        lastRenderMs === null ? 16 : Math.max(1, Math.min(50, renderElapsedMs - lastRenderMs));
      lastRenderMs = renderElapsedMs;
      if (goreVfx) {
        goreVfx.update(world, renderElapsedMs, deltaMs, interpAlpha);
      }
      if (corpseShatterVfx) {
        // Advance existing shards first so the clock is current, then spawn this
        // frame's bursts (born exactly at renderElapsedMs).
        corpseShatterVfx.update(renderElapsedMs, deltaMs);
        if (pendingShatter) {
          for (const opts of pendingShatter) corpseShatterVfx.explode(opts);
        }
      }
      // Juice effects (hit sparks, crit bursts, death pops, pickups, level-up).
      // Reads combatEvents BEFORE CombatVfx drains them; drains world.vfxEvents.
      effectsVfx.update(world, renderElapsedMs);
      // Small dust puffs behind the player — cosmetic only.
      playerTrailVfx.update(world, renderElapsedMs);
      // Process combat VFX (floating damage numbers)
      combatVfx.update(world, renderElapsedMs);
      // Boss/mob ability telegraphs, resolution bursts, Tarnished indicators.
      // Pure consumer of committed public cue state (world.mobAbilities).
      mobAbilityVfx.update(world);
    },

    destroy(): void {
      for (const visual of visuals.values()) {
        visual.obj.destroy();
      }
      visuals.clear();
      playerWalkMovingByEid.clear();
      acceptedStepDisplacementByEid.clear();
      for (const img of carriedWeaponVisuals.values()) {
        img.destroy();
      }
      carriedWeaponVisuals.clear();
      playerFacingRightByEid.clear();
      mobMotionStates.clear();
      for (const overlay of mobFlashOverlays.values()) {
        overlay.destroy();
      }
      mobFlashOverlays.clear();

      for (const marker of deathMarkers.values()) {
        marker.destroy();
      }
      deathMarkers.clear();

      for (const bg of beamGraphics.values()) {
        bg.destroy();
      }
      beamGraphics.clear();

      for (const ag of arcGraphics.values()) {
        ag.destroy();
      }
      arcGraphics.clear();
      arcSpawnMs.clear();

      for (const hg of harvestNodeGraphics.values()) {
        hg.destroy();
      }
      harvestNodeGraphics.clear();

      for (const img of harvestNodeImages.values()) {
        img.destroy();
      }
      harvestNodeImages.clear();

      for (const bar of mobHealthBars.values()) {
        bar.destroy();
      }
      mobHealthBars.clear();

      for (const tg of telegraphGraphics.values()) {
        tg.destroy();
      }
      telegraphGraphics.clear();

      for (const visual of propVisuals.values()) {
        visual.obj.destroy();
      }
      propVisuals.clear();

      for (const visual of setPiecePropVisuals.values()) {
        visual.obj.destroy();
      }
      setPiecePropVisuals.clear();

      for (const shadow of gemShadows.values()) {
        shadow.destroy();
      }
      gemShadows.clear();
      gemSpawnMs.clear();

      for (const shadow of goldShadows.values()) {
        shadow.destroy();
      }
      goldShadows.clear();
      goldSpawnMs.clear();

      goreVfx?.destroy();
      corpseShatterVfx?.destroy();
      effectsVfx.destroy();
      mobAbilityVfx.destroy();
      playerTrailVfx.destroy();
      combatVfx.destroy();
    },
  };
}
