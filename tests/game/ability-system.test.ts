import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { EffectiveStats, SkillHolder, Size, Enemy } from '../../src/core/components.js';
import { SHAPE_BOX } from '../../src/core/physics-defs.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { getStatusEffects } from '../../src/core/status-effects.js';
import { knockbackSystem } from '../../src/core/systems/knockbackSystem.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import { makeWalledMap } from '../helpers/map-fixtures.js';
import { ACTIVE_ABILITY_SLOT_LIMIT } from '../../src/game/abilities/types.js';
import {
  abilitySystem,
  equipActiveAbility,
  getOrCreateAbilityState,
  grantPassiveAbility,
  memorizeSpell,
  queueAbilityTrigger,
} from '../../src/game/systems/index.js';
import { forceActivateAbility } from '../../src/game/systems/abilitySystem.js';
import { applyCatalogEffect } from '../../src/game/systems/progressionEffects.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createRunEventCollector } from '../../src/core/run-events.js';

function setupPlayer() {
  const world = createTestWorld();
  const player = spawnPlayer(world, 0, 0);
  initializeBaseStats(world, player);
  addComponent(world.ecs, player, SkillHolder);
  statSystem(world);
  getOrCreateAbilityState(world, player);
  return { world, player };
}

describe('abilitySystem', () => {
  it('enforces max 10 active abilities equipped', () => {
    const { world, player } = setupPlayer();
    world.abilityStatesByEntity.set(player, {
      learnedSpellIds: [],
      equippedActiveAbilityIds: [
        'battle-focus',
        'heal',
        'pulse-shield',
        'magic-missile',
        'frost-nova',
        'bless',
        'stoneskin',
        'curse',
        'vampiric-touch',
        'haste',
      ],
      passiveAbilityIds: [],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
    });
    expect(world.abilityStatesByEntity.get(player)?.equippedActiveAbilityIds).toHaveLength(
      ACTIVE_ABILITY_SLOT_LIMIT,
    );

    expect(() => equipActiveAbility(world, player, 'fireball')).toThrow(/slot cap/i);
  });

  it('allows unlimited passive grants and applies them once through stat modifiers', () => {
    const { world, player } = setupPlayer();
    const state = world.abilityStatesByEntity.get(player)!;

    for (let i = 0; i < 12; i++) {
      state.passiveAbilityIds.push(`custom-passive-${i}`);
    }

    grantPassiveAbility(world, player, 'veteran-instinct');
    abilitySystem(world);

    const applied = world.statModifiers.filter((m) =>
      m.sourceId.startsWith('veteran-instinct:passive'),
    );
    expect(applied).toHaveLength(2);

    const before = world.statModifiers.length;
    abilitySystem(world);
    expect(world.statModifiers).toHaveLength(before);
  });

  it('memorized spells are active abilities', () => {
    const { world, player } = setupPlayer();
    memorizeSpell(world, player, 'fireball');

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.equippedActiveAbilityIds).toContain('fireball');
  });

  it('triggers active ability when conditions match and enforces cooldown', () => {
    const { world, player } = setupPlayer();
    equipActiveAbility(world, player, 'battle-focus');
    const state = world.abilityStatesByEntity.get(player)!;

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });

    world.frameCount = 100;
    const beforeFirst = world.statModifiers.length;
    abilitySystem(world);
    const afterFirst = world.statModifiers.filter(
      (m) => m.sourceId === `battle-focus:active:${player}`,
    );
    expect(world.statModifiers.length).toBe(beforeFirst + 1);
    expect(afterFirst).toHaveLength(1);

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });
    world.frameCount = 101;
    const beforeSecond = world.statModifiers.length;
    abilitySystem(world);
    const afterSecond = world.statModifiers.filter(
      (m) => m.sourceId === `battle-focus:active:${player}`,
    );
    expect(world.statModifiers.length).toBe(beforeSecond);
    expect(afterSecond).toHaveLength(1);
    expect(state.cooldownByAbilityId.get('battle-focus')).toBe(100);

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });
    world.frameCount = 131;
    const beforeThird = world.statModifiers.length;
    abilitySystem(world);
    const afterThird = world.statModifiers.filter(
      (m) => m.sourceId === `battle-focus:active:${player}`,
    );
    expect(world.statModifiers.length).toBe(beforeThird);
    expect(afterThird).toHaveLength(1);
    // Verify the trigger actually fired after cooldown by checking the cooldown timestamp updated
    expect(state.cooldownByAbilityId.get('battle-focus')).toBe(131);
    // Confirm cooldown advanced from the previous value (100 → 131)
    expect(state.cooldownByAbilityId.get('battle-focus')).toBeGreaterThan(100);
  });

  it('clears ability trigger events after processing', () => {
    const { world, player } = setupPlayer();
    equipActiveAbility(world, player, 'battle-focus');

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });

    abilitySystem(world);
    expect(world.abilityTriggerEvents).toHaveLength(0);
  });

  it('auto-casts fireball on enemy clumps and honors 5s cooldown', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'fireball');

    // Place enemies within 6 feet trigger radius and give them enough health to survive 2 spells
    spawnEnemy(world, 1, 0, 100);
    spawnEnemy(world, 1.5, 0.5, 100);
    spawnEnemy(world, 1.75, -0.5, 100);

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);

    world.frameCount = 200;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);

    world.frameCount = 400;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(400);
  });

  it('honors cooldown reduction by allowing an earlier second activation', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    addComponent(world.ecs, player, EffectiveStats);
    world.stores.effectiveStats.cooldownReduction[player] = 0.5;
    memorizeSpell(world, player, 'fireball');
    spawnEnemy(world, 1, 0, 100);
    spawnEnemy(world, 1.5, 0.5, 100);
    spawnEnemy(world, 1.75, -0.5, 100);

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);

    world.frameCount = 249; // base 300f cooldown would still block here
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);

    world.frameCount = 250; // reduced 150f cooldown should allow this cast
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(250);
  });

  it('does not add an extra frame for float32 near-integer cooldown products', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    addComponent(world.ecs, player, EffectiveStats);
    world.stores.effectiveStats.cooldownReduction[player] = 0.01;
    memorizeSpell(world, player, 'fireball');
    spawnEnemy(world, 1, 0, 100);
    spawnEnemy(world, 1.5, 0.5, 100);
    spawnEnemy(world, 1.75, -0.5, 100);

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);

    world.frameCount = 396;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);

    world.frameCount = 397;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(397);
  });

  it('keeps cooldown gate aligned to the snapped HUD cooldown when stats change mid-cooldown', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    addComponent(world.ecs, player, EffectiveStats);
    world.stores.effectiveStats.cooldownReduction[player] = 0;
    memorizeSpell(world, player, 'fireball');
    spawnEnemy(world, 1, 0, 100);
    spawnEnemy(world, 1.5, 0.5, 100);
    spawnEnemy(world, 1.75, -0.5, 100);

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);
    expect(state.cooldownFramesByAbilityId.get('fireball')).toBe(300);

    // Mid-cooldown stat changes should not desync the gate vs HUD countdown.
    world.stores.effectiveStats.cooldownReduction[player] = 0.5;
    world.frameCount = 250;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);

    world.frameCount = 400;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(400);
    expect(state.cooldownFramesByAbilityId.get('fireball')).toBe(150);
  });

  it('auto-casts fireball at a single nearby enemy without waiting for a cluster', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    // Fireball's authored base is 15 (scalesWithIntelligence), and a fresh
    // player's effective Intelligence is 1 (base, no allocation/gear), so the
    // resolved damage is round(15 * 1.01) = 15.
    memorizeSpell(world, player, 'fireball');

    // A lone enemy within the 6 ft trigger radius must still draw fire.
    const enemy = spawnEnemy(world, 3.75, 0, 100);

    world.frameCount = 100;
    abilitySystem(world);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);
    expect(world.stores.health.current[enemy]).toBe(85);
  });

  it('prioritizes the densest enemy cluster over a lone nearer enemy', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'fireball');

    // Lone enemy hugs the caster and is what trips the auto-trigger (within 6 ft),
    // but a tight cluster sits farther out within blast reach. The blast should
    // land on the cluster (3 hits) rather than the single nearby enemy (1 hit).
    const lone = spawnEnemy(world, -5, 0, 100);
    const clusterA = spawnEnemy(world, 10.625, 0, 100);
    const clusterB = spawnEnemy(world, 11.25, 1.25, 100);
    const clusterC = spawnEnemy(world, 10, -1.25, 100);

    world.frameCount = 100;
    abilitySystem(world);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);
    // Fireball damage (15) can crit like any other player-sourced hit on an
    // Enemy (SPELL_DAMAGE_OPTIONS.canCrit is true — see progressionEffects.ts).
    // Baseline crit chance is 0.05 + effective Luck (base 1, no allocation) *
    // 0.0025 = 0.0525 (see CORE_STAT_TO_SECONDARY.luck). With the fixed test
    // seed (42), the splash loop's second roll (clusterB) lands under that
    // chance and crits for 15*1.5=22.5; clusterA/clusterC roll non-crit hits.
    expect(world.stores.health.current[clusterA]).toBe(85);
    expect(world.stores.health.current[clusterB]).toBe(77.5);
    expect(world.stores.health.current[clusterC]).toBe(85);
    // The lone enemy triggered the cast but lies outside the cluster blast, so it
    // is spared — group priority, without ever being exclusive to clusters.
    expect(world.stores.health.current[lone]).toBe(100);
  });

  it('casts pulse shield only when low health and crowded', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'pulse-shield');
    world.stores.health.current[player] = 40;
    world.stores.health.max[player] = 100;

    spawnEnemy(world, 1.5, 0, 10);
    spawnEnemy(world, -1.25, 0.75, 10);

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.has('pulse-shield')).toBe(false);

    spawnEnemy(world, 0.75, -1, 10);
    world.frameCount = 200;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('pulse-shield')).toBe(200);

    world.stores.health.current[player] = 85;
    world.frameCount = 1600;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('pulse-shield')).toBe(200);
  });

  it('keeps pulse shield knockback from pushing enemies partially into walls', () => {
    const { world, player } = setupPlayer();
    world.floorMap = makeWalledMap({ tileSizeFt: 4 });
    world.stores.position.x[player] = 15;
    world.stores.position.y[player] = 12;
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'pulse-shield');
    world.stores.health.current[player] = 40;
    world.stores.health.max[player] = 100;

    spawnEnemy(world, 11, 12, 10);
    spawnEnemy(world, 12.5, 12, 10);
    const wallEnemy = spawnEnemy(world, 18, 12, 10);
    world.stores.sprite.width[wallEnemy] = 3.75;
    world.stores.sprite.height[wallEnemy] = 3.75;
    addComponent(
      world.ecs,
      wallEnemy,
      set(Size, { radius: 0, halfWidth: 1.875, halfHeight: 1.875, shape: SHAPE_BOX }),
    );
    // Pin all three enemy weights to the 120 lb knockback baseline so the
    // ±10% sizeScale jitter in `initializeEnemyAppearance` doesn't perturb
    // this bit-parity assertion. Slice 2 / ADR 0044: knockbackSystem now
    // scales displacement by 120/weight — a jittered 108–132 lb weight
    // would push wallEnemy to 18.11–18.14 ft instead of the exact 18.125.
    for (const e of query(world.ecs, [Enemy])) {
      world.stores.weight.value[e] = 120;
    }

    world.frameCount = 100;
    abilitySystem(world);
    knockbackSystem(world);

    // Knockback resolves in 0.125 ft substeps (the 1 px-equivalent sweep
    // resolution), so the enemy slides up against the wall and stops at 18.125 ft,
    // putting its right edge (18.125 + 3.75 / 2) exactly at the wall plane at 20 ft.
    expect(world.stores.position.x[wallEnemy]).toBeCloseTo(18.125);
    expect(world.stores.position.x[wallEnemy]! + 3.75 / 2).toBeLessThanOrEqual(20);
    expect(world.stores.position.y[wallEnemy]).toBeCloseTo(12);
  });

  it('casts heal only when HP deficit reaches heal amount, with 30s cooldown', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'heal');
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 75; // deficit 25 (< 30)

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.has('heal')).toBe(false);

    world.stores.health.current[player] = 70; // deficit 30
    world.frameCount = 200;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('heal')).toBe(200);

    world.stores.health.current[player] = 40;
    world.frameCount = 1000; // still inside 1800-frame cooldown
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('heal')).toBe(200);

    world.frameCount = 2001; // cooldown elapsed
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('heal')).toBe(2001);
  });

  it('emits a fireballBlast VFX event at the chosen epicentre when fireball casts', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'fireball');

    // Cluster of 3 sits 4 ft from the caster along +X; a lone enemy is closer.
    // Fireball's targeting picks the cluster centre as the epicentre, so the
    // pushed VFX event should carry that position (approx (4, 0)), not the
    // caster's (0, 0).
    spawnEnemy(world, 4, 0, 100);
    spawnEnemy(world, 4.5, 0.4, 100);
    spawnEnemy(world, 3.5, -0.4, 100);

    world.vfxEvents.length = 0;
    world.frameCount = 100;
    abilitySystem(world);

    const blasts = world.vfxEvents.filter((e) => e.kind === 'fireballBlast');
    expect(blasts).toHaveLength(1);
    expect(blasts[0]!.x).toBeGreaterThan(0);
    expect(Math.abs(blasts[0]!.y ?? 0)).toBeLessThan(1);
    // `intensity` is the cluster hit count (bestHits + 1), used to scale spark
    // count. A 3-enemy cluster produces intensity > 1 so the blast feels
    // weightier than a solo hit without inflating the ring past the real
    // blast area — the ring is sized from `radiusFt`.
    expect(blasts[0]!.intensity ?? 0).toBeGreaterThan(1);
    // `radiusFt` is the actual blast radius so the ring visually matches the
    // gameplay reach. Default tile size 4 ft × radiusTiles 3 = 12 ft.
    expect(blasts[0]!.radiusFt).toBeGreaterThan(0);
  });

  it('emits a pulseShieldWave VFX event centred on the caster when pulse shield fires', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'pulse-shield');
    world.stores.health.current[player] = 40;
    world.stores.health.max[player] = 100;
    spawnEnemy(world, 1.5, 0, 10);
    spawnEnemy(world, -1.5, 0, 10);
    spawnEnemy(world, 0, 1.5, 10);

    world.vfxEvents.length = 0;
    world.frameCount = 100;
    abilitySystem(world);

    const waves = world.vfxEvents.filter((e) => e.kind === 'pulseShieldWave');
    expect(waves).toHaveLength(1);
    expect(waves[0]!.x).toBe(0);
    expect(waves[0]!.y).toBe(0);
    // `radiusFt` is the knockback horizon so the ring visually reaches the
    // full effect radius. Default tile size 4 ft × radiusTiles 4 = 16 ft.
    expect(waves[0]!.radiusFt).toBeGreaterThan(0);
  });

  it('heals the caster and emits a healGlow VFX event when the heal spell auto-triggers on a deficit', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'heal');
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 70; // deficit 30 meets health_deficit_at_least

    world.vfxEvents.length = 0;
    world.frameCount = 100;
    abilitySystem(world);

    // The auto-trigger fires only on a real deficit, so HP is restored by the
    // resolved heal output (authored base 30, capped at max) and exactly one
    // glow is emitted at the caster.
    expect(world.stores.health.current[player]).toBe(100);
    const glows = world.vfxEvents.filter((e) => e.kind === 'healGlow');
    expect(glows).toHaveLength(1);
    expect(glows[0]!.x).toBe(0);
    expect(glows[0]!.y).toBe(0);
  });

  it('still emits a healGlow VFX event on a full-HP cast when there is nothing to heal', () => {
    const { world, player } = setupPlayer();
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 100; // full HP — zero healable

    world.vfxEvents.length = 0;
    world.frameCount = 100;
    // The health_deficit_at_least(30) auto-trigger can NEVER fire at full HP, so
    // drive the cast directly the way activateAbility() does. This exercises
    // castHeal's deliberate "always emit the glow on cast" branch (the spell
    // fired — cooldown started) which the trigger path cannot reach.
    applyCatalogEffect(world, {
      sourceType: 'ability',
      sourceId: `heal:active:${player}`,
      effect: { type: 'spell_heal', heal: { base: 30, scalesWithIntelligence: true } },
      holderEid: player,
    });

    expect(world.stores.health.current[player]).toBe(100); // nothing healed
    const glows = world.vfxEvents.filter((e) => e.kind === 'healGlow');
    expect(glows).toHaveLength(1);
    expect(glows[0]!.x).toBe(0);
    expect(glows[0]!.y).toBe(0);
  });

  it('casts magic missile at the nearest enemy and emits an arcaneBoltImpact VFX event', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'magic-missile');
    const target = spawnEnemy(world, 2, 0, 100);
    spawnEnemy(world, 8, 0, 100);

    world.vfxEvents.length = 0;
    world.frameCount = 100;
    abilitySystem(world);

    expect(world.stores.health.current[target]).toBeLessThan(100);
    const impacts = world.vfxEvents.filter((e) => e.kind === 'arcaneBoltImpact');
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.x).toBeCloseTo(2);
  });

  it('casts frost nova, damaging and slowing nearby enemies, and emits a frostNovaBurst VFX event', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'frost-nova');
    const enemy = spawnEnemy(world, 2, 0, 100);
    spawnEnemy(world, -2, 0, 100);
    spawnEnemy(world, 0, 2, 100);

    world.vfxEvents.length = 0;
    world.frameCount = 100;
    abilitySystem(world);

    expect(world.stores.health.current[enemy]).toBeLessThan(100);
    expect(getStatusEffects(world, enemy).some((effect) => effect.stat === 'speed')).toBe(true);
    const bursts = world.vfxEvents.filter((e) => e.kind === 'frostNovaBurst');
    expect(bursts).toHaveLength(1);
    expect(bursts[0]!.radiusFt).toBeGreaterThan(0);
  });

  it('force-fires bless as a timed buff and emits a buffAura VFX event', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'bless');

    world.vfxEvents.length = 0;
    world.frameCount = 100;
    expect(forceActivateAbility(world, player, 'bless')).toBe(true);

    const blessMods = world.statModifiers.filter((m) => m.sourceId === `bless:active:${player}`);
    expect(blessMods).toHaveLength(3);
    expect(blessMods.every((mod) => (mod.expiresFrame ?? 0) > 100)).toBe(true);
    const auras = world.vfxEvents.filter((e) => e.kind === 'buffAura');
    expect(auras).toHaveLength(1);
  });

  it('force-fires curse as a slow burst and emits a curseBurst VFX event', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'curse');
    const enemy = spawnEnemy(world, 2, 0, 100);
    spawnEnemy(world, -2, 0, 100);
    spawnEnemy(world, 0, 2, 100);
    spawnEnemy(world, 0, -2, 100);

    world.vfxEvents.length = 0;
    world.frameCount = 100;
    expect(forceActivateAbility(world, player, 'curse')).toBe(true);

    expect(getStatusEffects(world, enemy).some((effect) => effect.stat === 'speed')).toBe(true);
    const bursts = world.vfxEvents.filter((e) => e.kind === 'curseBurst');
    expect(bursts).toHaveLength(1);
  });

  it('force-fires vampiric touch, damaging the target, healing the caster, and emitting a lifeDrainBurst VFX event', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'vampiric-touch');
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 50;
    const enemy = spawnEnemy(world, 2, 0, 100);

    world.vfxEvents.length = 0;
    world.frameCount = 100;
    expect(forceActivateAbility(world, player, 'vampiric-touch')).toBe(true);

    expect(world.stores.health.current[player]).toBeGreaterThan(50);
    expect(world.stores.health.current[enemy]).toBeLessThan(100);
    const bursts = world.vfxEvents.filter((e) => e.kind === 'lifeDrainBurst');
    expect(bursts).toHaveLength(1);
    expect(bursts[0]!.x).toBeCloseTo(2);
  });

  describe('forceActivateAbility', () => {
    it('returns false for passive abilities', () => {
      const { world, player } = setupPlayer();
      grantPassiveAbility(world, player, 'veteran-instinct');
      const beforeMods = world.statModifiers.length;

      const fired = forceActivateAbility(world, player, 'veteran-instinct');

      expect(fired).toBe(false);
      // No `active` modifier for the passive ability id gets pushed.
      expect(
        world.statModifiers.filter((m) => m.sourceId === `veteran-instinct:active:${player}`),
      ).toHaveLength(0);
      expect(world.statModifiers.length).toBe(beforeMods);
    });

    it('returns false for unknown ability ids', () => {
      const { world, player } = setupPlayer();

      expect(forceActivateAbility(world, player, 'not-a-real-ability')).toBe(false);
    });

    it('returns false when the holder has no ability state', () => {
      const { world } = setupPlayer();
      // spawn a second entity but do NOT allocate ability state for it
      const stranger = spawnEnemy(world, 5, 5, 100);
      expect(world.abilityStatesByEntity.has(stranger)).toBe(false);

      expect(forceActivateAbility(world, stranger, 'battle-focus')).toBe(false);
    });

    it('returns false for spells when the spells feature is locked', () => {
      const { world, player } = setupPlayer();
      world.featureUnlocks.spells = false;
      // memorizeSpell equips it in an active slot even while the feature is locked.
      memorizeSpell(world, player, 'fireball');
      world.frameCount = 100;

      const fired = forceActivateAbility(world, player, 'fireball');

      expect(fired).toBe(false);
      const state = world.abilityStatesByEntity.get(player)!;
      expect(state.cooldownByAbilityId.has('fireball')).toBe(false);
    });

    it('bypasses cooldown when it fires, applies effects, and records the cast frame', () => {
      const { world, player } = setupPlayer();
      world.featureUnlocks.spells = true;
      memorizeSpell(world, player, 'heal');
      world.stores.health.max[player] = 100;
      world.stores.health.current[player] = 50;

      const state = world.abilityStatesByEntity.get(player)!;
      // Pre-seed the cooldown map so a normal activation would be blocked.
      state.cooldownByAbilityId.set('heal', 1000);
      world.frameCount = 1001;

      const fired = forceActivateAbility(world, player, 'heal');

      expect(fired).toBe(true);
      // Cast frame stamped at the current frame despite the recent prior cast.
      expect(state.cooldownByAbilityId.get('heal')).toBe(1001);
      // Effects were applied: HP restored above the pre-cast value.
      expect(world.stores.health.current[player]).toBeGreaterThan(50);
    });

    it('attributes successful learned-spell activations to the optional run-event collector', () => {
      const { world, player } = setupPlayer();
      world.runEvents = createRunEventCollector();
      world.featureUnlocks.spells = true;
      memorizeSpell(world, player, 'heal');

      expect(forceActivateAbility(world, player, 'heal')).toBe(true);
      expect(world.runEvents.itemActivations).toEqual([
        { activationId: 1, itemSources: ['spell:heal'] },
      ]);
    });

    it('force-fires an active ability twice in quick succession, ignoring its own cooldown', () => {
      const { world, player } = setupPlayer();
      equipActiveAbility(world, player, 'battle-focus');
      const state = world.abilityStatesByEntity.get(player)!;

      world.frameCount = 100;
      expect(forceActivateAbility(world, player, 'battle-focus')).toBe(true);
      expect(state.cooldownByAbilityId.get('battle-focus')).toBe(100);

      // Second cast one frame later — far inside battle-focus's cooldown, so
      // a normal activation would be gated. forceActivateAbility must still
      // fire and re-stamp the timestamp to the current frame.
      world.frameCount = 101;
      expect(forceActivateAbility(world, player, 'battle-focus')).toBe(true);
      expect(state.cooldownByAbilityId.get('battle-focus')).toBe(101);
    });
  });
});
