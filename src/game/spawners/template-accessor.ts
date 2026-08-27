/**
 * Template accessor utilities for spawner registry.
 * Provides convenient access to mob templates.
 */

import { AI_TYPE } from '../enemyAISystem.js';
import type { MobTemplate } from './types.js';
import type { EntitySpriteMappings } from '../../shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../../shared/data/entity-sprite-mappings.json';

const BLOOD_RAT = 0xcc0000;
const ENEMY_TEXTURES = (ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings).enemies;
const RAT_TEXTURE_ID = ENEMY_TEXTURES.enemy_rat?.textureId ?? 0;

export function getRatTemplate(): MobTemplate {
  return {
    id: 'rat',
    name: 'Rat',
    aiType: AI_TYPE.CHASE,
    hp: 8,
    speed: 0.225,
    aggroRange: 40,
    attackRange: 0,
    contactDamage: 4,
    weight: 6,
    bloodColor: BLOOD_RAT,
    textureId: RAT_TEXTURE_ID,
    spriteWidth: 1.5,
    spriteHeight: 1.5,
  };
}
