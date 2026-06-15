import { z } from 'zod';
import type { AbilityTriggerCondition as SharedAbilityTriggerCondition } from '../../shared/abilities.js';
import type { CatalogEffect } from '../../shared/progression-effects.js';
import { STAT_KEYS } from '../../shared/stats.js';

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
  description: string;
  category: AbilityCategory;
  flavorText?: string;
}

export interface ActiveAbilityDefinition extends AbilityDefinitionBase {
  kind: 'active' | 'spell';
  mpCost: number;
  cooldownFrames: number;
  trigger: SharedAbilityTriggerCondition;
  effects: CatalogEffect[];
}

export interface PassiveAbilityDefinition extends AbilityDefinitionBase {
  kind: 'passive';
  effects: CatalogEffect[];
}

export type AbilityDefinition = ActiveAbilityDefinition | PassiveAbilityDefinition;

const triggerConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('skill_usage'),
      metric: z.enum(['hits_landed', 'damage_dealt', 'distance_dodged_near_threat']),
      skillId: z.string().trim().min(1).optional(),
      minAmount: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('enemy_cluster'),
      minEnemies: z.number().int().min(2),
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
      damagePercent: z.number().positive(),
      radiusTiles: z.number().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_heal'),
      baseHeal: z.number().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('spell_pulse_shield'),
      knockbackForce: z.number().positive(),
      radiusTiles: z.number().positive(),
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
    description: z.string().trim().min(1),
    category: z.enum(['combat', 'defense', 'utility']),
    flavorText: z.string().trim().min(1).optional(),
  })
  .strict();

const activeAbilitySchema = baseAbilitySchema
  .extend({
    kind: z.enum(['active', 'spell']),
    mpCost: z.number().nonnegative(),
    cooldownFrames: z.number().int().positive(),
    trigger: triggerConditionSchema,
    effects: z.array(effectSchema).min(1),
  })
  .strict();

const passiveAbilitySchema = baseAbilitySchema
  .extend({
    kind: z.literal('passive'),
    effects: z.array(effectSchema).min(1),
  })
  .strict();

export const abilityDefinitionSchema: z.ZodType<AbilityDefinition> = z.discriminatedUnion('kind', [
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

    for (const def of definitions) {
      if (def.kind === 'spell' && def.mpCost <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Spell ${def.id} must have positive mpCost`,
          path: ['mpCost'],
        });
      }
    }
  });
