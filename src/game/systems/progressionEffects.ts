import type { CatalogEffect, TimedBuffModifier } from '../../shared/progression-effects.js';
import type { StatModifier } from '../../shared/skills.js';
import type { GameWorld } from '../../core/world.js';
import { applyDamage, type DamageOptions } from '../../core/apply-damage.js';
import { applyStatusEffect } from '../../core/status-effects.js';
import { addStatModifier } from './statsSystem.js';
import { resolveScalableOutput } from '../../shared/stats.js';
import { addComponent, hasComponent, query, set } from 'bitecs';
import {
  Enemy,
  EffectiveStats,
  Glowing,
  Health,
  Homing,
  Knockback,
  Player,
  Position,
} from '../../core/components.js';
import { spawnProjectile } from '../../core/spawners/projectiles.js';
import { tagDamageMeta } from '../../core/damage-meta.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';
import { getSpellSkillId } from '../../shared/spell-skills.js';

interface ApplyCatalogEffectOptions {
  sourceType: StatModifier['sourceType'];
  sourceId: string;
  effect: CatalogEffect;
  expiresFrame?: number;
  holderEid?: number;
}

const DEFAULT_TILE_SIZE_FT = 4;

const SPELL_SKILL_PER_LEVEL_BONUS = 0.02;
const SPELL_SKILL_BREAKPOINT_BONUSES = [
  { level: 5, bonus: 0.1 },
  { level: 10, bonus: 0.15 },
  { level: 15, bonus: 0.2 },
  { level: 20, bonus: 0.3 },
] as const;

/**
 * Magic Missile grants an extra bolt at each of these skill levels INSTEAD OF
 * the shared damage-breakpoint bonus below — see issue #3248 ("The 5/10/15/20
 * skill levels up grant extra missiles. The other levels improve damage.").
 * `getSpellSkillEfficacyMultiplier` special-cases 'magic-missile' to skip
 * `SPELL_SKILL_BREAKPOINT_BONUSES` so a breakpoint level doesn't double-dip
 * (extra missile AND the generic magnitude jump); the continuous per-level
 * bonus still applies at every level, magic-missile included.
 */
const MAGIC_MISSILE_EXTRA_MISSILE_LEVELS = [5, 10, 15, 20] as const;
const MAGIC_MISSILE_SPELL_ID = 'magic-missile';

/** Current level (0-20) of a holder's usage skill for the given spell, or 0. */
function getSpellSkillLevel(world: GameWorld, holderEid: number, spellId: string): number {
  const skillId = getSpellSkillId(spellId);
  if (!skillId) return 0;
  const state =
    world.skillStatesByEntity.get(holderEid)?.get(skillId) ??
    (hasComponent(world.ecs, holderEid, Player) ? world.playerSkills.get(skillId) : undefined);
  return Math.max(0, Math.min(20, state?.level ?? 0));
}

/** Reusable efficacy layer shared by every spell effect, including utility. */
function getSpellSkillEfficacyMultiplier(
  world: GameWorld,
  holderEid: number,
  spellId: string,
): number {
  if (!getSpellSkillId(spellId)) return 1;
  const level = getSpellSkillLevel(world, holderEid, spellId);
  let multiplier = 1 + level * SPELL_SKILL_PER_LEVEL_BONUS;
  // Magic Missile redirects the breakpoint dimension into extra bolts instead
  // of a magnitude jump (see MAGIC_MISSILE_EXTRA_MISSILE_LEVELS doc above).
  if (spellId !== MAGIC_MISSILE_SPELL_ID) {
    for (const breakpoint of SPELL_SKILL_BREAKPOINT_BONUSES) {
      if (level >= breakpoint.level) multiplier += breakpoint.bonus;
    }
  }
  return multiplier;
}

/** Number of bolts a Magic Missile cast fires: 1 base + 1 per breakpoint reached. */
function getMagicMissileCount(world: GameWorld, holderEid: number): number {
  const level = getSpellSkillLevel(world, holderEid, MAGIC_MISSILE_SPELL_ID);
  let count = 1;
  for (const breakpointLevel of MAGIC_MISSILE_EXTRA_MISSILE_LEVELS) {
    if (level >= breakpointLevel) count += 1;
  }
  return count;
}

function resolveSpellOutput(
  world: GameWorld,
  holderEid: number,
  spellId: string,
  output: { base: number; scalesWithIntelligence: boolean },
  intelligence: number,
  mode: 'magnitude' | 'slowMultiplier' = 'magnitude',
): number {
  const resolved = resolveScalableOutput(output, intelligence);
  const multiplier = getSpellSkillEfficacyMultiplier(world, holderEid, spellId);
  if (mode === 'slowMultiplier') {
    return Math.max(0.1, resolved - (multiplier - 1) * 0.25);
  }
  return resolved * multiplier;
}

/**
 * Magic-affinity damage options for a resolved spell hit. `scaleWithPrimary`
 * is FALSE because the spell's own numeric output already resolved its INT
 * scaling via `resolveScalableOutput` — applying the typed-primary multiplier
 * again in `applyDamage` would double-scale it. Spell damage can still crit.
 */
const SPELL_DAMAGE_OPTIONS: DamageOptions = {
  origin: 'player',
  affinity: 'magic',
  scaleWithPrimary: false,
  canCrit: true,
  fromActiveAbility: true,
};

function tilesToFeet(world: GameWorld, radiusTiles: number): number {
  const tileSizeFt = world.floorMap?.config.tileSizeFt ?? DEFAULT_TILE_SIZE_FT;
  return radiusTiles * tileSizeFt;
}

function getEffectiveIntelligence(world: GameWorld, casterEid: number): number {
  return hasComponent(world.ecs, casterEid, EffectiveStats)
    ? (world.stores.effectiveStats.intelligence[casterEid] ?? 0)
    : 0;
}

function findNearestLivingEnemy(
  world: GameWorld,
  casterEid: number,
  rangeFt: number,
): { eid: number; x: number; y: number } | null {
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const rangeSq = rangeFt * rangeFt;
  let best: {
    eid: number;
    x: number;
    y: number;
    distSq: number;
  } | null = null;

  for (const enemyEid of query(world.ecs, [Enemy, Position, Health])) {
    if ((world.stores.health.current[enemyEid] ?? 0) <= 0) continue;
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - casterX;
    const dy = ey - casterY;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) continue;
    if (!best || distSq < best.distSq) {
      best = { eid: enemyEid, x: ex, y: ey, distSq };
    }
  }

  return best ? { eid: best.eid, x: best.x, y: best.y } : null;
}

/**
 * Up to `maxCount` living enemies within range, nearest first. Used by Magic
 * Missile to fan its bolts across a cluster instead of dog-piling one target
 * when the skill's breakpoint levels grant extra missiles (issue #3248).
 *
 * Deliberate design choice (confirmed during adversarial plan review): the
 * issue only requires "extra missiles," not a specific targeting model, and
 * classic Magic Missile lore/expectation is multi-target auto-spread, which
 * also gives the multi-bolt visual payoff room to read clearly against a
 * cluster rather than always stacking on one enemy. Round-robins over this
 * list (`targets[i % targets.length]`) when there are fewer enemies than
 * missiles, so excess bolts still fire at the nearest available target(s)
 * rather than going unused.
 */
function findNearestLivingEnemies(
  world: GameWorld,
  casterEid: number,
  rangeFt: number,
  maxCount: number,
): { eid: number; x: number; y: number }[] {
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const rangeSq = rangeFt * rangeFt;
  const found: { eid: number; x: number; y: number; distSq: number }[] = [];

  for (const enemyEid of query(world.ecs, [Enemy, Position, Health])) {
    if ((world.stores.health.current[enemyEid] ?? 0) <= 0) continue;
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - casterX;
    const dy = ey - casterY;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) continue;
    found.push({ eid: enemyEid, x: ex, y: ey, distSq });
  }

  found.sort((a, b) => a.distSq - b.distSq);
  return found.slice(0, maxCount).map(({ eid, x, y }) => ({ eid, x, y }));
}

function castFireball(
  world: GameWorld,
  casterEid: number,
  damageOutput: CatalogEffect & { type: 'spell_fireball' },
  spellId: string,
): void {
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const effectiveIntelligence = getEffectiveIntelligence(world, casterEid);
  const radiusFt = tilesToFeet(
    world,
    resolveSpellOutput(world, casterEid, spellId, damageOutput.radiusTiles, effectiveIntelligence),
  );
  const radiusSq = radiusFt * radiusFt;
  const damage = Math.max(
    1,
    Math.round(
      resolveSpellOutput(world, casterEid, spellId, damageOutput.damage, effectiveIntelligence),
    ),
  );

  const enemies = [...query(world.ecs, [Enemy, Position, Health])].filter(
    (eid) => (world.stores.health.current[eid] ?? 0) > 0,
  );
  if (enemies.length === 0) return;

  // Pick the blast epicentre. Any living enemy within blast reach of the caster
  // is a candidate; prefer the one whose explosion catches the most enemies so
  // clusters are prioritised, and break ties by proximity to the caster so a
  // lone enemy still gets hit. This lets the fireball fire at any single enemy
  // without waiting for a group, while still favouring groups when they exist.
  let centerX = casterX;
  let centerY = casterY;
  let bestHits = -1;
  let bestDistSq = Number.POSITIVE_INFINITY;
  let hasTarget = false;

  for (const candidate of enemies) {
    const cx = world.stores.position.x[candidate] ?? 0;
    const cy = world.stores.position.y[candidate] ?? 0;
    const toCasterDx = cx - casterX;
    const toCasterDy = cy - casterY;
    const candidateDistSq = toCasterDx * toCasterDx + toCasterDy * toCasterDy;
    if (candidateDistSq > radiusSq) continue;

    let hits = 0;
    for (const other of enemies) {
      const ox = world.stores.position.x[other] ?? 0;
      const oy = world.stores.position.y[other] ?? 0;
      const dx = ox - cx;
      const dy = oy - cy;
      if (dx * dx + dy * dy <= radiusSq) hits += 1;
    }

    if (hits > bestHits || (hits === bestHits && candidateDistSq < bestDistSq)) {
      bestHits = hits;
      bestDistSq = candidateDistSq;
      centerX = cx;
      centerY = cy;
      hasTarget = true;
    }
  }

  if (!hasTarget) return;

  // Cast VFX: the fireball's damage numbers ride on the combat-event pipeline
  // (per-target hitSpark + damage floater), but nothing visualises the *cast*
  // itself — without this the player sees enemies quietly lose HP with no cue
  // that a spell fired. We only reach here when the spell actually connects (we
  // returned early above if no living enemy was in blast reach), and the chosen
  // epicentre is itself a living enemy, so the blast always catches at least one
  // target — even a lone-target hit reads as the full explosion.
  //
  // `radiusFt` scales the outer ring to the ACTUAL blast area (12 ft on Floor
  // 1), so a solo hit still reads as the full explosion the gameplay implies.
  // `intensity` is the cluster hit count — used only to spawn more sparks so
  // a big cluster feels weightier than a single-target pop, without inflating
  // the ring past the real blast radius.
  pushVfxEvent(world.vfxEvents, {
    kind: 'fireballBlast',
    x: centerX,
    y: centerY,
    radiusFt,
    intensity: Math.max(1, Math.min(bestHits + 1, 4)),
  });

  for (const enemyEid of enemies) {
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - centerX;
    const dy = ey - centerY;
    if (dx * dx + dy * dy <= radiusSq) {
      applyDamage(world, enemyEid, damage, ex, ey, {
        ...SPELL_DAMAGE_OPTIONS,
        sourceX: centerX,
        sourceY: centerY,
        sourceEid: casterEid,
      });
    }
  }
}

function castHeal(
  world: GameWorld,
  casterEid: number,
  healOutput: CatalogEffect & { type: 'spell_heal' },
  spellId: string,
): void {
  const effectiveIntelligence = getEffectiveIntelligence(world, casterEid);
  const baseHeal = Math.max(
    1,
    Math.round(
      resolveSpellOutput(world, casterEid, spellId, healOutput.heal, effectiveIntelligence),
    ),
  );
  const current = world.stores.health.current[casterEid] ?? 0;
  const max = world.stores.health.max[casterEid] ?? 100;
  const healable = Math.min(baseHeal, max - current);
  if (healable > 0) {
    world.stores.health.current[casterEid] = current + healable;
  }
  // Always emit the heal glow on cast — even a zero-healable cast represents
  // the spell actually firing (cooldown started), so the player needs a
  // visible cue that it happened.
  pushVfxEvent(world.vfxEvents, {
    kind: 'healGlow',
    x: world.stores.position.x[casterEid] ?? 0,
    y: world.stores.position.y[casterEid] ?? 0,
  });
}

function castPulseShield(
  world: GameWorld,
  casterEid: number,
  pulseOutput: CatalogEffect & { type: 'spell_pulse_shield' },
  spellId: string,
): void {
  const effectiveIntelligence = getEffectiveIntelligence(world, casterEid);
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const radiusFt = tilesToFeet(
    world,
    resolveSpellOutput(world, casterEid, spellId, pulseOutput.radiusTiles, effectiveIntelligence),
  );
  const radiusSq = radiusFt * radiusFt;
  const knockbackForce = resolveSpellOutput(
    world,
    casterEid,
    spellId,
    pulseOutput.knockbackForce,
    effectiveIntelligence,
  );

  // Cast VFX: an expanding shockwave centred on the caster. Pushed on every
  // cast (even when no enemies are in range) so the player sees the spell
  // trigger — the small knockback alone is otherwise easy to miss. `radiusFt`
  // scales the wave to the real knockback reach so it visually matches the
  // gameplay effect.
  pushVfxEvent(world.vfxEvents, {
    kind: 'pulseShieldWave',
    x: casterX,
    y: casterY,
    radiusFt,
  });

  const enemies = [...query(world.ecs, [Enemy, Position, Health])];
  for (const enemyEid of enemies) {
    if ((world.stores.health.current[enemyEid] ?? 0) <= 0) continue;
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - casterX;
    const dy = ey - casterY;
    const distSq = dx * dx + dy * dy;
    if (distSq <= radiusSq && distSq > 0) {
      const dist = Math.sqrt(distSq);
      if (!hasComponent(world.ecs, enemyEid, Knockback)) {
        addComponent(world.ecs, enemyEid, Knockback);
      }
      world.stores.knockback.dirX[enemyEid] = dx / dist;
      world.stores.knockback.dirY[enemyEid] = dy / dist;
      world.stores.knockback.remaining[enemyEid] = knockbackForce;
      world.stores.knockback.speed[enemyEid] = knockbackForce;
    }
  }
}

/** Magic Missile travel speed, in ft/frame — deliberately slow (well under the
 * 4-8 ft/frame range of starting weapons) so its arc-and-home flight is easy
 * for a human to track, per issue #3248. */
const MAGIC_MISSILE_SPEED_FT_PER_FRAME = 1.1;
/** Frames a missile flies its initial launch heading before homing kicks in —
 * the visible "arcs out from the player" phase. Deliberately short: at
 * `MAGIC_MISSILE_SPEED_FT_PER_FRAME` this is a ~6.6ft off-axis excursion
 * before the bolt starts curving back, small enough to reliably clear most
 * doorway/corridor geometry while still reading as a visible arc rather than
 * a beeline (adversarial plan review, issue #3248). */
const MAGIC_MISSILE_ARC_OUT_FRAMES = 6;
/** Per-missile launch-angle offset step (radians) used to fan multiple bolts
 * out from the caster instead of stacking them on one heading. Kept modest
 * (~20°) for the same wall-clearance reason as the arc-out duration above. */
const MAGIC_MISSILE_ARC_STEP_RAD = 0.35;
/** Max heading change per frame once homing activates (~14°/frame @60fps —
 * curves smoothly onto the target rather than snapping). */
const MAGIC_MISSILE_TURN_RATE_RAD_PER_FRAME = 0.24;
/** Safety-net despawn range so a missile whose target dies mid-flight cannot
 * fly forever; generous relative to cast range since the arc-out phase does
 * not travel in a straight line. */
const MAGIC_MISSILE_MAX_RANGE_MULTIPLIER = 2.5;
/** Small purple point-light every bolt carries in flight — Magic Missile must
 * "be a light source" per issue #3248. */
const MAGIC_MISSILE_GLOW_RADIUS_PX = 48;
const MAGIC_MISSILE_GLOW_INTENSITY = 0.5;
const MAGIC_MISSILE_GLOW_COLOR = { r: 0xc0, g: 0x84, b: 0xfc };

/** Launch-angle offset (radians) for the i-th of N simultaneous bolts. Every
 * bolt — including a solo missile (index 0) — launches off-axis from its
 * target and alternates sides, so a single Magic Missile visibly arcs out
 * before curving in rather than beelining; additional bolts fan progressively
 * wider so a multi-missile cast reads as a spread. */
function magicMissileArcOffsetRad(index: number): number {
  const half = Math.floor(index / 2) + 1;
  const sign = index % 2 === 0 ? 1 : -1;
  return sign * half * MAGIC_MISSILE_ARC_STEP_RAD;
}

function castMagicMissile(
  world: GameWorld,
  casterEid: number,
  missileOutput: CatalogEffect & { type: 'spell_magic_missile' },
  spellId: string,
): void {
  const effectiveIntelligence = getEffectiveIntelligence(world, casterEid);
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const rangeFt = tilesToFeet(
    world,
    resolveSpellOutput(world, casterEid, spellId, missileOutput.rangeTiles, effectiveIntelligence),
  );
  const missileCount = getMagicMissileCount(world, casterEid);
  const targets = findNearestLivingEnemies(world, casterEid, rangeFt, missileCount);
  if (targets.length === 0) return;
  const damage = Math.max(
    1,
    Math.round(
      resolveSpellOutput(world, casterEid, spellId, missileOutput.damage, effectiveIntelligence),
    ),
  );
  const maxRangeFt = rangeFt * MAGIC_MISSILE_MAX_RANGE_MULTIPLIER;
  const activateFrame = world.frameCount + MAGIC_MISSILE_ARC_OUT_FRAMES;

  for (let i = 0; i < missileCount; i += 1) {
    const target = targets[i % targets.length];
    if (!target) continue;
    const dx = target.x - casterX;
    const dy = target.y - casterY;
    const baseAngle = dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx);
    const launchAngle = baseAngle + magicMissileArcOffsetRad(i);
    const vx = Math.cos(launchAngle) * MAGIC_MISSILE_SPEED_FT_PER_FRAME;
    const vy = Math.sin(launchAngle) * MAGIC_MISSILE_SPEED_FT_PER_FRAME;

    const missileEid = spawnProjectile(
      world,
      casterX,
      casterY,
      vx,
      vy,
      damage,
      0,
      maxRangeFt,
      1,
      casterEid,
    );
    addComponent(
      world.ecs,
      missileEid,
      set(Homing, {
        targetEid: target.eid,
        speed: MAGIC_MISSILE_SPEED_FT_PER_FRAME,
        turnRateRadPerFrame: MAGIC_MISSILE_TURN_RATE_RAD_PER_FRAME,
        activateFrame,
      }),
    );
    addComponent(
      world.ecs,
      missileEid,
      set(Glowing, {
        radiusPx: MAGIC_MISSILE_GLOW_RADIUS_PX,
        intensity: MAGIC_MISSILE_GLOW_INTENSITY,
        colorR: MAGIC_MISSILE_GLOW_COLOR.r,
        colorG: MAGIC_MISSILE_GLOW_COLOR.g,
        colorB: MAGIC_MISSILE_GLOW_COLOR.b,
      }),
    );
    tagDamageMeta(world, missileEid, {
      origin: SPELL_DAMAGE_OPTIONS.origin,
      affinity: SPELL_DAMAGE_OPTIONS.affinity,
      scaleWithPrimary: SPELL_DAMAGE_OPTIONS.scaleWithPrimary,
      canCrit: SPELL_DAMAGE_OPTIONS.canCrit,
      fromActiveAbility: SPELL_DAMAGE_OPTIONS.fromActiveAbility,
    });
    // This is a spell cast, not a weapon-dispatched attack — explicitly
    // suppress the `attackerWeaponSkills` fallback so a missile's hit is never
    // mis-attributed to whichever weapon the player last fired (see
    // `emitWeaponHitSkillEventsForSource`).
    world.attackWeaponSkillsByEntity.set(missileEid, null);
  }
}

function applyTimedBuff(
  world: GameWorld,
  sourceType: StatModifier['sourceType'],
  sourceId: string,
  effectiveIntelligence: number,
  buffOutput: CatalogEffect & { type: 'spell_timed_buff' },
  modifiers: TimedBuffModifier[],
  holderEid: number,
  vfxColor?: number,
  spellId = '',
): void {
  const durationFrames = Math.max(
    1,
    Math.round(
      resolveSpellOutput(
        world,
        holderEid,
        spellId,
        buffOutput.durationFrames,
        effectiveIntelligence,
      ),
    ),
  );
  const nextExpiresFrame = world.frameCount + durationFrames;
  for (const modifier of modifiers) {
    addStatModifier(world, {
      sourceType,
      sourceId,
      stat: modifier.stat,
      op: modifier.op,
      value: resolveSpellOutput(world, holderEid, spellId, modifier.value, effectiveIntelligence),
      expiresFrame: nextExpiresFrame,
    });
  }
  pushVfxEvent(world.vfxEvents, {
    kind: 'buffAura',
    x: world.stores.position.x[holderEid] ?? 0,
    y: world.stores.position.y[holderEid] ?? 0,
    color: vfxColor,
  });
}

function applyEnemySlowBurst(
  world: GameWorld,
  holderEid: number,
  sourceId: string,
  effectiveIntelligence: number,
  slowOutput: CatalogEffect & { type: 'spell_enemy_slow_burst' },
  spellId: string,
): void {
  const centerX = world.stores.position.x[holderEid] ?? 0;
  const centerY = world.stores.position.y[holderEid] ?? 0;
  const radiusFt = tilesToFeet(
    world,
    resolveSpellOutput(world, holderEid, spellId, slowOutput.radiusTiles, effectiveIntelligence),
  );
  const radiusSq = radiusFt * radiusFt;
  const slowMultiplier = resolveSpellOutput(
    world,
    holderEid,
    spellId,
    slowOutput.slowMultiplier,
    effectiveIntelligence,
    'slowMultiplier',
  );
  const slowDurationMs = Math.max(
    1,
    Math.round(
      resolveSpellOutput(
        world,
        holderEid,
        spellId,
        slowOutput.slowDurationMs,
        effectiveIntelligence,
      ),
    ),
  );
  pushVfxEvent(world.vfxEvents, {
    kind: 'curseBurst',
    x: centerX,
    y: centerY,
    radiusFt,
    color: slowOutput.vfxColor,
  });
  for (const enemyEid of query(world.ecs, [Enemy, Position, Health])) {
    if ((world.stores.health.current[enemyEid] ?? 0) <= 0) continue;
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - centerX;
    const dy = ey - centerY;
    if (dx * dx + dy * dy > radiusSq) continue;
    applyStatusEffect(world, enemyEid, {
      stat: 'speed',
      op: 'multiply',
      value: slowMultiplier,
      durationMs: slowDurationMs,
      sourceType: 'ability',
      sourceId,
      stackRule: { mode: 'replace' },
    });
  }
}

function castFrostNova(
  world: GameWorld,
  casterEid: number,
  effectiveIntelligence: number,
  novaOutput: CatalogEffect & { type: 'spell_frost_nova' },
  sourceId: string,
  spellId: string,
): void {
  const centerX = world.stores.position.x[casterEid] ?? 0;
  const centerY = world.stores.position.y[casterEid] ?? 0;
  const radiusFt = tilesToFeet(
    world,
    resolveSpellOutput(world, casterEid, spellId, novaOutput.radiusTiles, effectiveIntelligence),
  );
  const radiusSq = radiusFt * radiusFt;
  const damage = Math.max(
    1,
    Math.round(
      resolveSpellOutput(world, casterEid, spellId, novaOutput.damage, effectiveIntelligence),
    ),
  );
  const slowMultiplier = resolveSpellOutput(
    world,
    casterEid,
    spellId,
    novaOutput.slowMultiplier,
    effectiveIntelligence,
    'slowMultiplier',
  );
  const slowDurationMs = Math.max(
    1,
    Math.round(
      resolveSpellOutput(
        world,
        casterEid,
        spellId,
        novaOutput.slowDurationMs,
        effectiveIntelligence,
      ),
    ),
  );
  pushVfxEvent(world.vfxEvents, {
    kind: 'frostNovaBurst',
    x: centerX,
    y: centerY,
    radiusFt,
  });
  for (const enemyEid of query(world.ecs, [Enemy, Position, Health])) {
    if ((world.stores.health.current[enemyEid] ?? 0) <= 0) continue;
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - centerX;
    const dy = ey - centerY;
    if (dx * dx + dy * dy > radiusSq) continue;
    applyDamage(world, enemyEid, damage, ex, ey, {
      ...SPELL_DAMAGE_OPTIONS,
      sourceX: centerX,
      sourceY: centerY,
      sourceEid: casterEid,
    });
    applyStatusEffect(world, enemyEid, {
      stat: 'speed',
      op: 'multiply',
      value: slowMultiplier,
      durationMs: slowDurationMs,
      sourceType: 'ability',
      sourceId,
      stackRule: { mode: 'replace' },
    });
  }
}

function castLifeDrain(
  world: GameWorld,
  casterEid: number,
  drainOutput: CatalogEffect & { type: 'spell_life_drain' },
  spellId: string,
): void {
  const effectiveIntelligence = getEffectiveIntelligence(world, casterEid);
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const rangeFt = tilesToFeet(
    world,
    resolveSpellOutput(world, casterEid, spellId, drainOutput.rangeTiles, effectiveIntelligence),
  );
  const target = findNearestLivingEnemy(world, casterEid, rangeFt);
  if (!target) return;
  const damage = Math.max(
    1,
    Math.round(
      resolveSpellOutput(world, casterEid, spellId, drainOutput.damage, effectiveIntelligence),
    ),
  );
  const dealt = applyDamage(world, target.eid, damage, target.x, target.y, {
    ...SPELL_DAMAGE_OPTIONS,
    sourceX: casterX,
    sourceY: casterY,
    sourceEid: casterEid,
  });
  if (dealt <= 0) return;
  // Healing is independent of the actual damage DEALT (not a percent-of-dealt
  // lifesteal) — its own authored base, resolved through the same shared
  // helper at the same effective Intelligence, so the two outputs scale
  // together without one deriving from the other's post-crit/overkill result.
  const healAmount = Math.max(
    1,
    Math.round(
      resolveSpellOutput(world, casterEid, spellId, drainOutput.heal, effectiveIntelligence),
    ),
  );
  const max = world.stores.health.max[casterEid] ?? 100;
  const current = world.stores.health.current[casterEid] ?? 0;
  world.stores.health.current[casterEid] = Math.min(max, current + healAmount);
  pushVfxEvent(world.vfxEvents, {
    kind: 'lifeDrainBurst',
    x: target.x,
    y: target.y,
    color: 0xf472b6,
  });
}

export function applyCatalogEffect(world: GameWorld, options: ApplyCatalogEffectOptions): void {
  const { sourceType, sourceId, effect, expiresFrame, holderEid } = options;
  const spellId = sourceId.split(':', 1)[0] ?? '';

  switch (effect.type) {
    case 'stat_add':
      addStatModifier(world, {
        sourceType,
        sourceId,
        stat: effect.stat,
        op: 'add',
        value: effect.value,
        expiresFrame,
      });
      break;

    case 'stat_multiply':
      addStatModifier(world, {
        sourceType,
        sourceId,
        stat: effect.stat,
        op: 'multiply',
        value: effect.value,
        expiresFrame,
      });
      break;

    case 'extra_projectile':
      addStatModifier(world, {
        sourceType,
        sourceId,
        stat: 'projectileCount',
        op: 'add',
        value: effect.count,
        expiresFrame,
      });
      break;

    case 'aura':
      // TODO: Aura effects carry radius/dpsPercentOfDamage but are not yet implemented.
      // This no-op modifier registers the source so the aura system (future) can query active auras.
      addStatModifier(world, {
        sourceType,
        sourceId,
        stat: 'damage',
        op: 'add',
        value: 0,
        expiresFrame,
      });
      break;

    case 'spell_fireball':
      if (holderEid !== undefined) {
        castFireball(world, holderEid, effect, spellId);
      }
      break;

    case 'spell_heal':
      if (holderEid !== undefined) {
        castHeal(world, holderEid, effect, spellId);
      }
      break;

    case 'spell_pulse_shield':
      if (holderEid !== undefined) {
        castPulseShield(world, holderEid, effect, spellId);
      }
      break;

    case 'spell_magic_missile':
      if (holderEid !== undefined) {
        castMagicMissile(world, holderEid, effect, spellId);
      }
      break;

    case 'spell_frost_nova':
      if (holderEid !== undefined) {
        castFrostNova(
          world,
          holderEid,
          getEffectiveIntelligence(world, holderEid),
          effect,
          sourceId,
          spellId,
        );
      }
      break;

    case 'spell_timed_buff':
      if (holderEid !== undefined) {
        applyTimedBuff(
          world,
          sourceType,
          sourceId,
          getEffectiveIntelligence(world, holderEid),
          effect,
          effect.modifiers,
          holderEid,
          effect.vfxColor,
          spellId,
        );
      }
      break;

    case 'spell_enemy_slow_burst':
      if (holderEid !== undefined) {
        applyEnemySlowBurst(
          world,
          holderEid,
          sourceId,
          getEffectiveIntelligence(world, holderEid),
          effect,
          spellId,
        );
      }
      break;

    case 'spell_life_drain':
      if (holderEid !== undefined) {
        castLifeDrain(world, holderEid, effect, spellId);
      }
      break;
  }
}
