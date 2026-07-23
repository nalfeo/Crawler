import {
  enemyVariantFromTextureId,
  generatedBriefIdForEnemy,
} from '../../engine/phaser-bridge/sprite-kind.js';
import { getSheet, getSprite } from '../../engine/sprites/registry.js';
import { ENEMY_PROJECTILE } from '../../shared/constants.js';
import type { EntitySpriteMappings } from '../../shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../../shared/data/entity-sprite-mappings.json';
import {
  floor1EnemyPack,
  floor2EnemyPack,
  type EnemyArchetypeDef,
} from '../../shared/enemy-packs.js';
import type { MobLocomotionStyle, MobSpriteOption } from './model.js';

export interface MobPreviewSpec {
  readonly archetypeId: string;
  readonly briefId: string;
  readonly label: string;
  readonly name: string;
  readonly floorLabel: string;
  readonly aiType: EnemyArchetypeDef['aiType'];
  readonly movementStyle: MobLocomotionStyle;
  readonly hasProjectile: boolean;
  readonly telegraphMs: number;
}

export interface ProjectileFrameSpec {
  readonly renderKind: 'enemy_aoe_proj';
  readonly spriteId: string;
  readonly sheetPath: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly displayScale: number;
}

const FAMILY_MOVEMENT_STYLES: Readonly<Partial<Record<string, MobLocomotionStyle>>> = {
  batfolk: 'hover',
  faeries: 'hover',
  toadkin: 'hop',
  snailfolk: 'slither',
  beetlefolk: 'stomp',
  crabfolk: 'stomp',
  molefolk: 'stomp',
  pandas: 'stomp',
};

const ARCHETYPE_MOVEMENT_STYLES: Readonly<Partial<Record<string, MobLocomotionStyle>>> = {
  slime: 'hop',
  'cave-slime': 'hop',
  'cave-bat-swarm': 'hover',
  'glow-worm': 'slither',
  'blind-cave-newt': 'slither',
  'fungal-husk': 'stomp',
};

const PROJECTILE_RENDER_KIND = 'enemy_aoe_proj' as const;

function locomotionStyleForArchetype(archetype: EnemyArchetypeDef): MobLocomotionStyle {
  const explicit = ARCHETYPE_MOVEMENT_STYLES[archetype.id];
  if (explicit) return explicit;

  if (archetype.familyId) {
    const familyStyle = FAMILY_MOVEMENT_STYLES[archetype.familyId];
    if (familyStyle) return familyStyle;
  }

  return archetype.isBoss === true ? 'stomp' : 'stride';
}

function resolveMobPreviewSpec(
  archetype: EnemyArchetypeDef,
  floorLabel: string,
): MobPreviewSpec | null {
  const visualType = enemyVariantFromTextureId(archetype.spriteTexture);
  const briefId = generatedBriefIdForEnemy(visualType, archetype.id);
  if (!briefId) return null;

  const hasProjectile = archetype.aiType === 'ranged';
  return {
    archetypeId: archetype.id,
    briefId,
    label: `${floorLabel} · ${archetype.name}`,
    name: archetype.name,
    floorLabel,
    aiType: archetype.aiType,
    movementStyle: locomotionStyleForArchetype(archetype),
    hasProjectile,
    telegraphMs: hasProjectile ? ENEMY_PROJECTILE.TELEGRAPH_MS : 0,
  };
}

export function buildMobPreviewSpecs(): readonly MobPreviewSpec[] {
  const specs = [
    ...floor1EnemyPack.archetypes.map((archetype) => resolveMobPreviewSpec(archetype, 'Floor 1')),
    ...floor2EnemyPack.archetypes.map((archetype) => resolveMobPreviewSpec(archetype, 'Floor 2')),
  ].filter((spec): spec is MobPreviewSpec => spec !== null);

  return specs.sort(
    (a, b) =>
      a.floorLabel.localeCompare(b.floorLabel) ||
      a.name.localeCompare(b.name) ||
      a.archetypeId.localeCompare(b.archetypeId),
  );
}

export function availableMobPreviewSpecs(
  sprites: readonly MobSpriteOption[],
  specs: readonly MobPreviewSpec[] = buildMobPreviewSpecs(),
): readonly MobPreviewSpec[] {
  const availableBriefs = new Set(sprites.map((sprite) => sprite.briefId));
  return specs.filter((spec) => availableBriefs.has(spec.briefId));
}

export function resolveEnemyProjectileFrame(): ProjectileFrameSpec {
  const mappings = ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings;
  const renderMapping = mappings.renderKinds[PROJECTILE_RENDER_KIND];
  if (!renderMapping?.kenneySpriteId) {
    throw new Error(`${PROJECTILE_RENDER_KIND} has no configured sprite ID.`);
  }

  const sprite = getSprite(renderMapping.kenneySpriteId);
  if (!sprite) {
    throw new Error(`Unknown projectile sprite: ${renderMapping.kenneySpriteId}`);
  }
  const sheet = getSheet(sprite.sheetKey);
  if (!sheet) {
    throw new Error(`Unknown projectile sheet: ${sprite.sheetKey}`);
  }

  const column = sprite.frame % sheet.cols;
  const row = Math.floor(sprite.frame / sheet.cols);
  return {
    renderKind: PROJECTILE_RENDER_KIND,
    spriteId: sprite.id,
    sheetPath: sheet.path,
    sourceX: sheet.margin + column * (sheet.frameWidth + sheet.spacing),
    sourceY: sheet.margin + row * (sheet.frameHeight + sheet.spacing),
    frameWidth: sheet.frameWidth,
    frameHeight: sheet.frameHeight,
    displayScale: renderMapping.kenneyScale ?? 1,
  };
}
