import { hasComponent, query } from 'bitecs';
import type Phaser from 'phaser';
import { DeathTimer, Position, Prop, Rotation, Sprite } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { getSprite } from './sprites/index.js';
import { createCombatVfx } from './CombatVfx.js';
import { createGoreVfx } from './GoreVfx.js';
import { createCorpseShatterVfx, type CorpseExplodeOptions } from './CorpseShatterVfx.js';
import { createEffectsVfx } from './EffectsVfx.js';
import { computeCorpseDecay, type CorpseDecay } from './corpse-decay.js';
import { createLogger } from '../shared/logger.js';
import { MeleeSpriteId } from '../shared/constants.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from './generatedAssets/index.js';
import type { GeneratedSpriteRegistry } from '../shared/generated-assets.js';
import { ftToPx } from '../shared/units.js';
import { DEFAULT_HANDHELD_SPRITE_ANCHOR } from '../shared/sprite-anchor.js';
import { DECORATION_INDEX_TO_ID, getDecorationDef } from '../shared/decorationDefs.js';
import { PROP_DEPTH } from '../shared/render-depths.js';
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
  enemyVariantFromTextureId,
  generatedBriefIdForEnemy,
  pickGeneratedEnemyTextureKey,
  resolveRenderKind,
  SLIME_FULL_SPRITE_WIDTH,
} from './phaser-bridge/sprite-kind.js';
import { BOSS_BAR_COLORS } from './boss-health-bar-state.js';
import type { EntitySpriteMappings } from '../shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../shared/data/entity-sprite-mappings.json';

const DEAD_SKULL_Y_OFFSET = 18;
const MOB_HEALTH_BAR_HEIGHT_PX = 3;
const MOB_HEALTH_BAR_MIN_WIDTH_PX = 16;
const MOB_HEALTH_BAR_MAX_WIDTH_PX = 28;
const MOB_HEALTH_BAR_Y_GAP_PX = 2;
/** Fallback half-height when a sprite's displayHeight is unavailable. */
const MOB_HEALTH_BAR_DEFAULT_SPRITE_HALF_HEIGHT_PX = 8;
const logger = createLogger('engine:phaser-bridge');

interface EntityVisual {
  obj: Phaser.GameObjects.Image;
  type: string;
  /** Base scale to restore in the default per-frame branch. */
  baseScale: number;
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

const RENDER_KIND_CONFIGS = (ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings).renderKinds;

interface ResolvedTexture {
  key: string;
  /** Frame index when `key` references a spritesheet. */
  frame?: number;
  /** Base render scale for this texture. */
  scale: number;
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
 * Resolve the texture (and frame) to use for the given entity type.
 * Prefers an approved generated sprite, then a Kenney sprite when both
 * the registry mapping and the loaded texture exist; otherwise falls
 * back to the procedural `__cw_*` texture.
 */
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

function resolveGeneratedTexture(
  scene: Phaser.Scene,
  type: string,
  generated: EntitySpriteMappings['renderKinds'][string]['generated'] | undefined,
  options?: { appearanceKey?: string; variantRoll?: number },
): { key: string; scale: number } | null {
  if (generated === undefined || scene.textures === undefined) {
    return null;
  }

  const registryKey = pickGeneratedEnemyTextureKey(
    getGeneratedSpriteRegistry(scene),
    type,
    options?.variantRoll,
    options?.appearanceKey,
  );
  if (registryKey !== null && scene.textures.exists(registryKey)) {
    return { key: registryKey, scale: generated.scale };
  }

  if (scene.textures.exists(generated.pinnedTextureKey)) {
    return { key: generated.pinnedTextureKey, scale: generated.scale };
  }

  if (scene.textures.exists(generated.briefId)) {
    return { key: generated.briefId, scale: generated.scale };
  }

  const textureKeys = scene.textures.getTextureKeys?.();
  if (!Array.isArray(textureKeys)) {
    return null;
  }

  const prefix = `${generated.briefId}-var-`;
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
  return selectedKey === undefined ? null : { key: selectedKey, scale: generated.scale };
}

function getProceduralTextureForType(type: string): string {
  const token = (RENDER_KIND_CONFIGS[type]?.proceduralTexture ??
    'default') as ProceduralTextureToken;
  return PROCEDURAL_TEXTURE_KEYS[token] ?? PROCEDURAL_TEXTURE_KEYS.default;
}

export function createPhaserBridge(scene: Phaser.Scene): {
  sync(world: GameWorld, renderElapsedMs?: number, interpAlpha?: number): void;
  destroy(): void;
} {
  generateTextures(scene);

  const visuals = new Map<number, EntityVisual>();
  const deathMarkers = new Map<number, Phaser.GameObjects.Image>();
  const beamGraphics = new Map<number, Phaser.GameObjects.Graphics>();
  const arcGraphics = new Map<number, Phaser.GameObjects.Graphics>();
  const mobHealthBars = new Map<number, Phaser.GameObjects.Graphics>();
  /** Tracks spawn time for arc entities so we can animate the sweep. */
  const arcSpawnMs = new Map<number, number>();
  /** Per-harvestable node Graphics (body circle + progress ring redrawn each frame). */
  const harvestNodeGraphics = new Map<number, Phaser.GameObjects.Graphics>();
  /** Tracks first-seen render time for XP gems so the bob phase is per-gem. */
  const gemSpawnMs = new Map<number, number>();
  /** Ground shadow ellipses for each XP gem entity. */
  const gemShadows = new Map<number, Phaser.GameObjects.Ellipse>();
  /** Tracks first-seen render time for gold drops so the bob phase is per-coin. */
  const goldSpawnMs = new Map<number, number>();
  /** Ground shadow ellipses for each gold entity. */
  const goldShadows = new Map<number, Phaser.GameObjects.Ellipse>();
  /** Placeholder rectangles for Prop entities (coloured by depth layer). */
  const propVisuals = new Map<number, Phaser.GameObjects.Rectangle>();
  const combatVfx = createCombatVfx(scene);
  const goreVfx =
    typeof scene.add.rectangle === 'function'
      ? createGoreVfx(scene, { intensity: 1.25, hitGoreEnabled: true })
      : null;
  const corpseShatterVfx =
    typeof scene.add.image === 'function' ? createCorpseShatterVfx(scene) : null;
  const effectsVfx = createEffectsVfx(scene);
  const missingSpriteWarnings = new Set<string>();
  const missingTypeWarnings = new Set<string>();
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
      const resolvePreferredTexture = (
        type: string,
        options?: { appearanceKey?: string; variantRoll?: number },
      ): ResolvedTexture => {
        const registry = getGeneratedSpriteRegistry(scene);
        const briefId = generatedBriefIdForEnemy(type, options?.appearanceKey);
        const hasGeneratedVariants =
          briefId !== undefined && registry !== null && registry.variants(briefId).length > 0;
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
      const { position, velocity, lineDamage, trap, areaDamage, lifetime, meleeSwing } =
        world.stores;

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
            // Use the live render scale (not baseScale) so shrunken variants
            // like baby slimes shatter at their actual on-screen size.
            scale = visual.obj.scaleX || visual.baseScale;
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
        if (entityType === 'enemy' && world.floor1 != null) {
          for (const [key, battle] of world.floor1.objective.bossBattles.entries()) {
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
                : 'enemy_boss'
              : enemyVariantFromTextureId(world.stores.sprite.textureId[eid])
            : entityType;
        const appearanceKey =
          entityType === 'enemy' ? world.enemyAppearanceKeys.get(eid) : undefined;
        // Positions/velocities are stored in feet; scale feet → pixels for
        // rendering (the only place pixels exist). All downstream geometry
        // (beam/melee/aoe lengths, tip offsets) is computed in pixels too.
        const x = ftToPx((position.x[eid] ?? 0) + (velocity.x[eid] ?? 0) * interpAlpha);
        const y = ftToPx((position.y[eid] ?? 0) + (velocity.y[eid] ?? 0) * interpAlpha);

        // --- Harvestable node rendering (body circle + progress ring) ---
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

          // Node body: filled circle with outline.
          hg.lineStyle(1, 0x000000, 0.7);
          hg.fillStyle(nodeColor, 1.0);
          hg.fillCircle(x, y, BODY_RADIUS);
          hg.strokeCircle(x, y, BODY_RADIUS);

          // Progress ring: visible only while being harvested.
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

          // Harvestable nodes manage their own Graphics — skip the image path.
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
          // The hold anchor (DEFAULT_HANDHELD_SPRITE_ANCHOR) marks the grip on a
          // 16×16 frame (x=8, y=14 — near the handle end). We pin that anchor to
          // the player center so the weapon always appears to be held at the body.
          //
          // Derivation: with rotation = tipAngle + π/2 the local-up direction
          // (0,−1) maps to screen direction (cos tipAngle, sin tipAngle), so the
          // tip of the sprite is at origin + holdAnchor.y × scale × (cos, sin).
          // Setting holdAnchor.y × scale = bladeLen makes the sprite tip land
          // exactly at tipX/tipY while the grip stays at the player center.
          const WEAPON_SPRITE_FRAME_HEIGHT = 16;
          const holdY = DEFAULT_HANDHELD_SPRITE_ANCHOR.y; // 14 px from top
          // Minimum scale ensuring the sprite remains visually readable for
          // very short weapons where the computed scale would be near-zero.
          const MIN_WEAPON_SPRITE_SCALE = 1.8;
          const weaponScale = bladeLen > holdY ? bladeLen / holdY : MIN_WEAPON_SPRITE_SCALE;
          const handX = x;
          const handY = y;

          const swingSprite = meleeSwing.spriteId[eid] ?? 0;
          const weaponSpriteKey = swingSprite === MeleeSpriteId.BAT ? 'weapon.bat' : 'weapon.sword';
          const weaponSpriteDef = getSprite(weaponSpriteKey);

          let visual = visuals.get(eid);
          if (!visual && weaponSpriteDef) {
            const img = scene.add.image(
              handX,
              handY,
              weaponSpriteDef.sheetKey,
              weaponSpriteDef.frame,
            );
            // Origin at hold anchor so the sprite pivots from the player's hand
            img.setOrigin(0.5, holdY / WEAPON_SPRITE_FRAME_HEIGHT);
            img.setScale(weaponScale);
            visuals.set(eid, { obj: img, type: entityType, baseScale: weaponScale });
            visual = visuals.get(eid);
          }

          if (visual) {
            visual.obj.setVisible(alpha > 0.05);
            visual.obj.setAlpha(alpha);
            // Recompute origin/scale each frame in case the sprite was reused
            visual.obj.setOrigin(0.5, holdY / WEAPON_SPRITE_FRAME_HEIGHT);
            visual.obj.setScale(weaponScale);
            visual.obj.setPosition(handX, handY);
            // +π/2 aligns local-up (blade tip) with tipAngle (away from player)
            visual.obj.setRotation(tipAngle + Math.PI / 2);
          }
          continue;
        }
        let visual = visuals.get(eid);

        if (!visual || visual.type !== visualType) {
          if (visual) {
            visual.obj.destroy();
          }
          const resolved = resolveTexture(scene, visualType, {
            appearanceKey,
            variantRoll: world.stores.sprite.variantRoll[eid],
          });
          const img =
            resolved.frame !== undefined
              ? scene.add.image(x, y, resolved.key, resolved.frame)
              : scene.add.image(x, y, resolved.key);
          if (resolved.scale !== 1) {
            img.setScale(resolved.scale);
          }
          if (resolved.fallback) {
            logFallback(visualType);
          }
          visual = { obj: img, type: visualType, baseScale: resolved.scale };
          visuals.set(eid, visual);
        }

        const img = visual.obj;
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
            visual.baseScale = preferred.scale;
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
              img.setScale(scaleX, scaleY);
            } else {
              img.setScale(visual.baseScale);
            }
            break;
        }

        // Corpse styling wins over the per-type switch: a dead enemy drains
        // toward grey (multiply tint) and fades out across its linger window.
        if (corpseDecay) {
          if (typeof img.setTint === 'function') {
            img.setTint(corpseDecay.tint);
          }
          img.setAlpha(corpseDecay.corpseAlpha);
        } else if (visual.deathTotalMs !== undefined) {
          // This visual previously backed a corpse but its EID has been
          // recycled for a living entity (bitecs reuses freed EIDs). Clear the
          // leftover grey multiply-tint and stale linger duration so the reused
          // sprite renders normally and recalibrates cleanly on its next death.
          if (typeof img.clearTint === 'function') {
            img.clearTint();
          }
          visual.deathTotalMs = undefined;
        }

        if (entityType === 'enemy') {
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
        }
      }

      // --- Prop render pass ---
      // Render Prop entities as coloured placeholder rectangles until real
      // sprites are available. Props render at PROP_DEPTH below all entities.
      const activePropEids = new Set<number>();
      for (const propEid of query(world.ecs, [Prop, Position])) {
        activePropEids.add(propEid);
        const propX = ftToPx(position.x[propEid] ?? 0);
        const propY = ftToPx(position.y[propEid] ?? 0);
        const defIdIndex = world.stores.prop.defIdIndex[propEid] ?? 0;
        const defId = DECORATION_INDEX_TO_ID[defIdIndex];
        const decorationDef = defId !== undefined ? getDecorationDef(defId) : undefined;
        const scalePx = ftToPx(decorationDef?.scale ?? 1.0);
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

        let rect = propVisuals.get(propEid);
        if (!rect && typeof scene.add.rectangle === 'function') {
          rect = scene.add.rectangle(propX, propY, scalePx, scalePx, fillColor, 0.6);
          rect.setDepth(depth);
          propVisuals.set(propEid, rect);
        } else if (rect) {
          rect.setPosition(propX, propY);
        }
      }
      // Clean up removed prop visuals.
      for (const [propEid, rect] of propVisuals) {
        if (!activePropEids.has(propEid)) {
          rect.destroy();
          propVisuals.delete(propEid);
        }
      }

      // Clean up removed entities
      for (const [eid, visual] of visuals) {
        if (activeEntities.has(eid)) {
          continue;
        }
        visual.obj.destroy();
        visuals.delete(eid);
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

      for (const [eid, bar] of mobHealthBars) {
        if (activeEntities.has(eid)) {
          continue;
        }
        bar.destroy();
        mobHealthBars.delete(eid);
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
      // Process combat VFX (floating damage numbers)
      combatVfx.update(world, renderElapsedMs);
    },

    destroy(): void {
      for (const visual of visuals.values()) {
        visual.obj.destroy();
      }
      visuals.clear();

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

      for (const bar of mobHealthBars.values()) {
        bar.destroy();
      }
      mobHealthBars.clear();

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
      combatVfx.destroy();
    },
  };
}
