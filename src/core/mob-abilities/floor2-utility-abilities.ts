import { addComponent, hasComponent, query, set, setComponent } from 'bitecs';
import {
  getFloor2BossAbilityById,
  formatBossAbilityAnnouncement,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import { Health, Knockback, Player, Position } from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { applyStatusEffect, clearStatusEffects } from '../status-effects.js';
import { activateMobAbilitySelfBuff } from './runtime.js';
import type { MobAbilityRuntimeDefinition } from './types.js';

function catalog(id: string): BossAbilityDef {
  const ability = getFloor2BossAbilityById(id);
  if (!ability) throw new Error(`Missing Floor 2 ability ${id}`);
  return ability;
}
function number(ability: BossAbilityDef, id: string, unit: string, effect = false): number {
  const field = (effect ? ability.effect.designValues : ability.telegraph.metrics).find(
    (v) => v.id === id,
  );
  if (
    !field ||
    field.unit !== unit ||
    typeof field.value !== 'number' ||
    !Number.isFinite(field.value)
  )
    throw new Error(`${ability.id}: invalid ${id}`);
  return field.value;
}
function expectValue(ability: BossAbilityDef, id: string, value: string | boolean): void {
  if (ability.effect.designValues.find((v) => v.id === id)?.value !== value)
    throw new Error(`${ability.id}: invalid ${id}`);
}
function base(ability: BossAbilityDef) {
  return {
    abilityId: ability.id,
    bossArchetypeKey: ability.bossArchetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
  };
}

export function createShellCompanyLockdownDefinition(): MobAbilityRuntimeDefinition {
  const ability = catalog('kingpin-molt-shell-company-lockdown');
  expectValue(ability, 'stacking', false);
  expectValue(ability, 'knockback-immunity', true);
  const auraRadiusFt = number(ability, 'radius', 'feet');
  const buff = {
    durationMs: number(ability, 'duration', 'milliseconds', true),
    damageTakenMultiplier: 1 - number(ability, 'damage-reduction', 'percent', true) / 100,
    movementSpeedMultiplier: 1,
    meleeDamageMultiplier: 1,
    knockbackResistanceMultiplier: 0,
    auraRadiusFt,
  };
  return {
    ...base(ability),
    geometry: { kind: 'circle', radiusFt: auraRadiusFt },
    targetingMode: 'self',
    originMode: 'follows-caster',
    lockCasterDuringTelegraph: true,
    resolve: (world, ctx) =>
      activateMobAbilitySelfBuff(world, {
        ...buff,
        abilityId: ability.id,
        casterEid: ctx.casterEid,
        sourceId: ctx.sourceId,
      }),
  };
}

export function createOmertaHonkDefinition(): MobAbilityRuntimeDefinition {
  const ability = catalog('don-honkrado-omerta-honk');
  expectValue(ability, 'damage-profile', 'moderate');
  expectValue(ability, 'knockback-profile', 'strong');
  expectValue(ability, 'debuff-id', 'rattled');
  const rangeFt = number(ability, 'range', 'feet');
  const angleDeg = number(ability, 'angle', 'degrees');
  const durationMs = number(ability, 'duration', 'milliseconds', true);
  const outgoingDamage = 1 + number(ability, 'outgoing-damage-modifier', 'percent', true) / 100;
  return {
    ...base(ability),
    geometry: { kind: 'circle', radiusFt: rangeFt },
    targetingMode: 'player-direction',
    originMode: 'locked',
    lockCasterDuringTelegraph: true,
    commitGeometry: ({ world, casterEid, lockedX, lockedY }) => ({
      kind: 'cone',
      originX: world.stores.position.x[casterEid]!,
      originY: world.stores.position.y[casterEid]!,
      facingRad: Math.atan2(
        lockedY - world.stores.position.y[casterEid]!,
        lockedX - world.stores.position.x[casterEid]!,
      ),
      angleDeg,
      rangeFt,
    }),
    resolve: (world, ctx) => {
      if (ctx.geometry.kind !== 'cone') return;
      const g = ctx.geometry;
      for (const eid of query(world.ecs, [Player, Position, Health])) {
        if (world.stores.health.current[eid]! <= 0) continue;
        const x = world.stores.position.x[eid]!,
          y = world.stores.position.y[eid]!;
        const dx = x - g.originX,
          dy = y - g.originY;
        const distance = Math.hypot(dx, dy),
          angle = Math.atan2(dy, dx) - g.facingRad;
        if (
          distance > g.rangeFt ||
          Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) > (g.angleDeg * Math.PI) / 360
        )
          continue;
        const dealt = applyDamage(world, eid, 20, x, y, {
          origin: 'enemy',
          affinity: 'magic',
          scaleWithPrimary: false,
          canCrit: false,
          sourceEid: ctx.casterEid,
          sourceX: g.originX,
          sourceY: g.originY,
        });
        if (dealt <= 0 || world.stores.health.current[eid]! <= 0) continue;
        // Strong impulse uses the existing swept, wall-safe knockback system.
        const impulse = {
          dirX: distance ? dx / distance : Math.cos(g.facingRad),
          dirY: distance ? dy / distance : Math.sin(g.facingRad),
          remaining: 6,
          speed: 0.6,
        };
        if (hasComponent(world.ecs, eid, Knockback))
          setComponent(world.ecs, eid, Knockback, impulse);
        else addComponent(world.ecs, eid, set(Knockback, impulse));
        clearStatusEffects(
          world,
          eid,
          (effect) =>
            effect.stat === 'outgoingDamage' &&
            effect.sourceId.startsWith(`mob-ability:${ability.id}:`),
        );
        applyStatusEffect(world, eid, {
          stat: 'outgoingDamage',
          op: 'multiply',
          value: outgoingDamage,
          durationMs,
          sourceType: 'ability',
          sourceId: ctx.sourceId,
          stackRule: { mode: 'replace' },
        });
      }
    },
  };
}
