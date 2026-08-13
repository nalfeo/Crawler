import { z } from 'zod';
import type { AbilityTriggerCondition as SharedAbilityTriggerCondition } from '../../shared/abilities.js';
import type { CatalogEffect, TimedBuffModifier } from '../../shared/progression-effects.js';
import { STAT_KEYS, type ScalableOutput } from '../../shared/stats.js';
import {
  WEAPON_CLASS_SKILL_IDS,
  WEAPON_TYPE_SKILL_IDS,
  type WeaponSkillId,
} from '../../shared/weapon-skills.js';

export { ACTIVE_ABILITY_SLOT_LIMIT } from '../../shared/abilities.js';
export type {
  AbilityState,
  AbilityTriggerCondition,
  AbilityTriggerEvent,
} from '../../shared/abilities.js';

export type AbilityCategory = 'combat' | 'defense' | 'utility';

export interface AbilityDefinitionBase {
  id: string;
  name: string;
  shortLabel: string;
  description: string;
  category: AbilityCategory;
  iconBriefId?: string;
  flavorText?: string;
}

export interface ActiveAbilityDefinition extends AbilityDefinitionBase {
  kind: 'active' | 'spell';
  cooldownFrames: number;
  trigger: SharedAbilityTriggerCondition;
  effects: CatalogEffect[];
}

export interface PassiveAbilityDefinition extends AbilityDefinitionBase {
  kind: 'passive';
  effects: CatalogEffect[];
  passiveEffectSummary?: string;
  passiveRequirementSummary?: string;
  /**
   * Optional weapon skill prerequisite. When set, the passive's stat bonuses
   * are only applied while the player has a weapon of the given class or type
   * equipped. Removing or swapping to an ineligible weapon disables the passive
   * until a qualifying weapon is re-equipped.
   *
   * Weapon CLASS prerequisites (e.g. 'slashing') require any weapon whose
   * `weaponClassSkillId` matches. Weapon TYPE prerequisites (e.g. 'sword')
   * require any weapon whose `weaponTypeSkillId` matches.
   */
  weaponPrerequisite?: WeaponSkillId;
}

export type AbilityDefinition = ActiveAbilityDefinition | PassiveAbilityDefinition;

// Re-export WeaponSkillId for consumers of this module.
export type { WeaponSkillId };

const triggerConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('skill_usage'),
      metric: z.enum([
        'hits_landed',
        'damage_dealt',
        'distance_dodged_near_threat',
        'weapon_fired',
        'spell_used',
      ]),
      skillId: z.string().trim().min(1).optional(),
      minAmount: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('enemy_cluster'),
      minEnemies: z.number().int().min(1),
      withinFeet: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('low_health'),
      healthBelowRatio: z.number().positive().max(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('low_health_crowded'),
      healthBelowRatio: z.number().positive().max(1),
      minEnemies: z.number().int().min(1),
      withinFeet: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('health_deficit_at_least'),
      deficitAmount: z.number().positive(),
    })
    .strict(),
]);

const statKeySchema = z.enum(STAT_KEYS);
const finiteScalableOutputSchema: z.ZodType<ScalableOutput> = z
  .object({
    base: z.number().finite(),
    scalesWithIntelligence: z.boolean(),
  })
  .strict();
const timedBuffModifierSchema: z.ZodType<TimedBuffModifier> = z
  .object({
    stat: statKeySchema,
    op: z.enum(['add', 'multiply']),
    value: finiteScalableOutputSchema,
  })
  .strict();

/**
 * Every magical ability numeric output is inline `{ base, scalesWithIntelligence }`
 * so it explicitly declares whether it scales with effective Intelligence —
 * see `shared/stats.ts#resolveScalableOutput`.
 *
 * Field-specific constraints:
 *   - `positiveScalableOutputSchema`        — base > 0 (damage, heal, radius, range, knockback)
 *   - `positiveIntegerScalableOutputSchema` — base is a positive integer (frame/ms durations)
 *   - `slowMultiplierScalableOutputSchema`  — 0 < base <= 1 (slow multiplier)
 */
/** Scalable output where `base` must be positive (damage, heal, radius, range, knockback). */
const positiveScalableOutputSchema: z.ZodType<ScalableOutput> = z
  .object({
    base: z.number().positive(),
    scalesWithIntelligence: z.boolean(),
  })
  .strict();

/** Scalable output where `base` must be a positive integer (frame/ms durations). */
const positiveIntegerScalableOutputSchema: z.ZodType<ScalableOutput> = z
  .object({
    base: z.number().int().positive(),
    scalesWithIntelligence: z.boolean(),
  })
  .strict();

/**
 * Scalable output where `base` must satisfy `0 < base <= 1` (slow multiplier:
 * 1 = no slow, approaching 0 = near-complete stop; zero or negative is invalid).
 */
const slowMultiplierScalableOutputSchema: z.ZodType<ScalableOutput> = z
  .object({
    base: z.number().positive().max(1),
    scalesWithIntelligence: z.boolean(),
  })
  .strict();

const effectSchema: z.ZodType<CatalogEffect> = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('stat_add'),
      stat: statKeySchema,
      value: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal('stat_multiply'),
      stat: statKeySchema,
      value: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal('extra_projectile'),
      count: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal('aura'),
      radius: z.number().positive(),
      dpsPercentOfDamage: z.number().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_fireball'),
      damage: positiveScalableOutputSchema,
      radiusTiles: positiveScalableOutputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_heal'),
      heal: positiveScalableOutputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_pulse_shield'),
      knockbackForce: positiveScalableOutputSchema,
      radiusTiles: positiveScalableOutputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_magic_missile'),
      damage: positiveScalableOutputSchema,
      rangeTiles: positiveScalableOutputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_frost_nova'),
      damage: positiveScalableOutputSchema,
      radiusTiles: positiveScalableOutputSchema,
      slowMultiplier: slowMultiplierScalableOutputSchema,
      slowDurationMs: positiveIntegerScalableOutputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_timed_buff'),
      durationFrames: positiveIntegerScalableOutputSchema,
      modifiers: z.array(timedBuffModifierSchema).min(1),
      vfxColor: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_enemy_slow_burst'),
      radiusTiles: positiveScalableOutputSchema,
      slowMultiplier: slowMultiplierScalableOutputSchema,
      slowDurationMs: positiveIntegerScalableOutputSchema,
      vfxColor: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_life_drain'),
      damage: positiveScalableOutputSchema,
      rangeTiles: positiveScalableOutputSchema,
      heal: positiveScalableOutputSchema,
    })
    .strict(),
]);

const baseAbilitySchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/),
    name: z.string().trim().min(1),
    shortLabel: z.string().trim().min(1).max(8),
    description: z.string().trim().min(1),
    category: z.enum(['combat', 'defense', 'utility']),
    iconBriefId: z.string().trim().min(1).optional(),
    flavorText: z.string().trim().min(1).optional(),
  })
  .strict();

const activeAbilitySchema = baseAbilitySchema
  .extend({
    kind: z.enum(['active', 'spell']),
    cooldownFrames: z.number().int().positive(),
    trigger: triggerConditionSchema,
    effects: z.array(effectSchema).min(1),
  })
  .strict();

// All valid weapon skill prerequisite IDs — class skills union type skills.
const WEAPON_PREREQ_IDS = [...WEAPON_CLASS_SKILL_IDS, ...WEAPON_TYPE_SKILL_IDS] as const;

const passiveAbilitySchema = baseAbilitySchema
  .extend({
    kind: z.literal('passive'),
    effects: z.array(effectSchema).min(1),
    weaponPrerequisite: z.enum(WEAPON_PREREQ_IDS).optional(),
    passiveEffectSummary: z.string().trim().min(1).optional(),
    passiveRequirementSummary: z.string().trim().min(1).optional(),
  })
  .strict();

const abilityDefinitionSchema: z.ZodType<AbilityDefinition> = z.discriminatedUnion('kind', [
  activeAbilitySchema,
  passiveAbilitySchema,
]);

export const abilityCatalogSchema = z
  .array(abilityDefinitionSchema)
  .superRefine((definitions, ctx) => {
    const ids = new Set<string>();
    for (const def of definitions) {
      if (ids.has(def.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate ability id: ${def.id}`,
        });
      }
      ids.add(def.id);
    }
  });
