/**
 * Deterministic coverage for the typed mob-ability runtime and Queen Mab's
 * Verdigris Glamour. Every timing assertion is expressed in fixed simulation
 * steps (`GAME.DELTA_MS`), never wall-clock time; randomness is never used.
 *
 * Hard success gate (issue #1260): a run records at least two fully resolved
 * casts with the exact phase cadence — first eligibility 9,000ms, first
 * resolution 10,500ms, second eligibility 19,500ms, second resolution
 * 21,000ms — while the default normal-game configuration records zero casts.
 */
import { describe, expect, it } from 'vitest';
import { addComponent, removeEntity } from 'bitecs';
import { createTestWorld } from '../../helpers/world-factory.js';
import { GAME } from '../../../src/shared/constants.js';
import { createInputState } from '../../../src/shared/input.js';
import {
  spawnPlayer,
  spawnBehaviorEnemy,
  setEnemyAppearanceKey,
  getStatusEffects,
  computeEffectiveValue,
  statusEffectSystem,
  mobAbilitySystem,
  healthSystem,
  registerMobAbility,
  clearMobAbility,
  setMobAbilitiesEnabled,
  activateMobAbilityEncounter,
  disableMobAbilityEncounter,
  createVerdigrisGlamourDefinition,
  mobAbilitySourceId,
  applyStatusEffect,
  VERDIGRIS_GLAMOUR_ABILITY_ID,
  DeathTimer,
  set,
  type MobAbilityRuntimeDefinition,
} from '../../../src/core/index.js';
import { runCoreSimulationStep } from '../../../src/core/simulation-core-step.js';
import { AI_TYPE } from '../../../src/game/enemyAISystem.js';
import { enemyAISystem, weaponSystem } from '../../../src/game/index.js';
import {
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
} from '../../../src/labs/combat-arena-lab/arena-data.js';
import { SeededRandom } from '../../../src/shared/random.js';

const DELTA = GAME.DELTA_MS;
const QUEEN_KEY = 'faerie-boss';
const EXPECTED_ANNOUNCEMENT = 'VERDIGRIS GLAMOUR — All that glitters will corrode!';

// Exact deterministic frame boundaries derived from the catalog cadence.
const FIRST_TELEGRAPH_FRAME = 540; // 9,000ms
const FIRST_RESOLUTION_FRAME = 630; // 10,500ms
const SECOND_TELEGRAPH_FRAME = 1170; // 19,500ms
const SECOND_RESOLUTION_FRAME = 1260; // 21,000ms

type World = ReturnType<typeof createTestWorld>;

interface Harness {
  world: World;
  player: number;
  queen: number;
  def: MobAbilityRuntimeDefinition;
}

/** Build a world with a stationary player at (px,py) and Queen Mab at (qx,qy). */
function buildHarness(px = 40, py = 40, qx = 40, qy = 10): Harness {
  const world = createTestWorld();
  const player = spawnPlayer(world, px, py);
  // Give the player plenty of HP so ability + contact damage never ends the run.
  world.stores.health.current[player] = 100_000;
  world.stores.health.max[player] = 100_000;
  const queen = spawnBehaviorEnemy(world, qx, qy, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(world, queen, QUEEN_KEY);
  const def = createVerdigrisGlamourDefinition();
  return { world, player, queen, def };
}

/** Arm the runtime: enable, register the ability for the queen, activate. */
function arm(h: Harness): void {
  setMobAbilitiesEnabled(h.world, true);
  registerMobAbility(h.world, h.queen, h.def);
  activateMobAbilityEncounter(h.world);
}

function setPosition(h: Harness, eid: number, x: number, y: number): void {
  h.world.stores.position.x[eid] = x;
  h.world.stores.position.y[eid] = y;
}

/** Step the executor directly (production order: statusEffect then ability). */
function step(world: World, frames: number): void {
  for (let i = 0; i < frames; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    statusEffectSystem(world);
    mobAbilitySystem(world);
  }
}

/** Record the frame + elapsedMs of each telegraph-start and resolution. */
function recordTimeline(h: Harness, frames: number) {
  const telegraphs: Array<{ frame: number; elapsedMs: number }> = [];
  const resolutions: Array<{ frame: number; elapsedMs: number }> = [];
  let prevAnnounce = 0;
  let prevResolved = 0;
  for (let i = 0; i < frames; i += 1) {
    h.world.frameCount += 1;
    h.world.elapsedMs += DELTA;
    statusEffectSystem(h.world);
    mobAbilitySystem(h.world);
    const inst = h.world.mobAbilities.byEntity.get(h.queen);
    if (inst === undefined) continue;
    if (inst.announcementsEmitted > prevAnnounce) {
      telegraphs.push({ frame: h.world.frameCount, elapsedMs: h.world.elapsedMs });
      prevAnnounce = inst.announcementsEmitted;
    }
    if (inst.resolvedCasts > prevResolved) {
      resolutions.push({ frame: h.world.frameCount, elapsedMs: h.world.elapsedMs });
      prevResolved = inst.resolvedCasts;
    }
  }
  return { telegraphs, resolutions };
}

describe('Verdigris Glamour — typed definition', () => {
  it('derives the exact catalog contract', () => {
    const def = createVerdigrisGlamourDefinition();
    expect(def.abilityId).toBe(VERDIGRIS_GLAMOUR_ABILITY_ID);
    expect(def.bossArchetypeKey).toBe(QUEEN_KEY);
    expect(def.firstEligibleAfterMs).toBe(9000);
    expect(def.cooldownMs).toBe(9000);
    expect(def.telegraphDurationMs).toBe(1500);
    expect(def.dangerColor).toBe('hostile-red');
    expect(def.geometry).toEqual({ kind: 'circle', radiusFt: 12 });
    expect(def.announcementText).toBe(EXPECTED_ANNOUNCEMENT);
  });
});

describe('Verdigris Glamour — timing gate', () => {
  it('first eligibility at 9,000ms and first resolution at 10,500ms', () => {
    const h = buildHarness();
    arm(h);
    const { telegraphs, resolutions } = recordTimeline(h, FIRST_RESOLUTION_FRAME + 5);
    expect(telegraphs[0]?.frame).toBe(FIRST_TELEGRAPH_FRAME);
    expect(resolutions[0]?.frame).toBe(FIRST_RESOLUTION_FRAME);
    // Within one simulation-step boundary of the exact wall-clock targets.
    expect(Math.abs(telegraphs[0]!.elapsedMs - 9000)).toBeLessThan(DELTA);
    expect(Math.abs(resolutions[0]!.elapsedMs - 10500)).toBeLessThan(DELTA);
    // Telegraph window is exactly 1.5s.
    expect(resolutions[0]!.elapsedMs - telegraphs[0]!.elapsedMs).toBeCloseTo(1500, 6);
  });

  it('records two full recurring casts with the exact cadence', () => {
    const h = buildHarness();
    arm(h);
    const { telegraphs, resolutions } = recordTimeline(h, SECOND_RESOLUTION_FRAME + 5);
    expect(telegraphs.map((t) => t.frame)).toEqual([FIRST_TELEGRAPH_FRAME, SECOND_TELEGRAPH_FRAME]);
    expect(resolutions.map((r) => r.frame)).toEqual([
      FIRST_RESOLUTION_FRAME,
      SECOND_RESOLUTION_FRAME,
    ]);
    expect(Math.abs(telegraphs[1]!.elapsedMs - 19500)).toBeLessThan(DELTA);
    expect(Math.abs(resolutions[1]!.elapsedMs - 21000)).toBeLessThan(DELTA);
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.resolvedCasts).toBe(2);
  });

  it('anchors the cooldown after resolution, not at telegraph start', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME);
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.phase).toBe('cooldown');
    expect(inst.resolvedCasts).toBe(1);
    // Cooldown timer starts at the full 9,000ms from the resolution frame.
    expect(inst.timerMs).toBeGreaterThan(9000 - DELTA * 1.5);
    expect(inst.timerMs).toBeLessThanOrEqual(9000);
  });
});

describe('Verdigris Glamour — one active cast per entity', () => {
  it('never runs two overlapping telegraphs and re-registration resets the clock', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 10); // mid first telegraph
    expect(h.world.mobAbilities.cues.filter((c) => c.casterEid === h.queen)).toHaveLength(1);
    // Re-register mid-cast: the instance resets to a fresh cooldown clock.
    registerMobAbility(h.world, h.queen, h.def);
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.phase).toBe('cooldown');
    expect(inst.timerMs).toBe(9000);
    expect(inst.resolvedCasts).toBe(0);
  });
});

describe('Verdigris Glamour — target lock and geometry', () => {
  it('locks a 12ft circle at the player position and never tracks afterward', () => {
    const h = buildHarness(40, 40);
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME); // telegraph just started
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.phase).toBe('telegraph');
    expect(inst.committedGeometry).toEqual({ kind: 'circle', x: 40, y: 40, radiusFt: 12 });
    // Move the player far away mid-telegraph — geometry must NOT follow.
    setPosition(h, h.player, 400, 400);
    step(h.world, 10);
    const inst2 = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst2.committedGeometry).toEqual({ kind: 'circle', x: 40, y: 40, radiusFt: 12 });
  });
});

describe('Verdigris Glamour — damage resolution', () => {
  it('damages a target inside the committed circle and applies Tarnished', () => {
    const h = buildHarness();
    const before = h.world.stores.health.current[h.player]!;
    h.def.resolve(h.world, {
      abilityId: h.def.abilityId,
      casterEid: h.queen,
      sourceId: mobAbilitySourceId(h.def.abilityId, h.queen),
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
      targetEid: h.player,
    });
    expect(h.world.stores.health.current[h.player]!).toBeLessThan(before);
    expect(getStatusEffects(h.world, h.player).length).toBeGreaterThan(0);
  });

  it('does not apply Tarnished when the damage is lethal', () => {
    const h = buildHarness();
    // Set player HP to exactly the ability's damage amount so the hit is lethal.
    // After resolution the player must be at 0 HP with NO status effects — retaining
    // Tarnished post-death violates the dead-target cleanup contract and would cause
    // MobAbilityVfx to render a Tarnished ring during game-over.
    h.world.stores.health.current[h.player] = 20; // exact damage amount → lethal hit
    h.def.resolve(h.world, {
      abilityId: h.def.abilityId,
      casterEid: h.queen,
      sourceId: mobAbilitySourceId(h.def.abilityId, h.queen),
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
      targetEid: h.player,
    });
    expect(h.world.stores.health.current[h.player]!).toBe(0);
    expect(getStatusEffects(h.world, h.player)).toHaveLength(0);
  });

  it('does not damage a target outside the committed circle', () => {
    const h = buildHarness();
    const before = h.world.stores.health.current[h.player]!;
    h.def.resolve(h.world, {
      abilityId: h.def.abilityId,
      casterEid: h.queen,
      sourceId: mobAbilitySourceId(h.def.abilityId, h.queen),
      // Circle centered 100ft away — the player at (40,40) is well outside.
      geometry: { kind: 'circle', x: 140, y: 140, radiusFt: 12 },
      targetEid: h.player,
    });
    expect(h.world.stores.health.current[h.player]!).toBe(before);
    expect(getStatusEffects(h.world, h.player)).toHaveLength(0);
  });

  it('does not friendly-fire another enemy standing inside the committed circle', () => {
    const h = buildHarness();
    // A second enemy shares the player's tile — inside the circle — but must not
    // take ability damage even if it occupied the recycled target id.
    const other = spawnBehaviorEnemy(h.world, 40, 40, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    const before = h.world.stores.health.current[other]!;
    h.def.resolve(h.world, {
      abilityId: h.def.abilityId,
      casterEid: h.queen,
      sourceId: mobAbilitySourceId(h.def.abilityId, h.queen),
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
      // Even when the recycled id points at an enemy, resolution must skip it.
      targetEid: other,
    });
    expect(h.world.stores.health.current[other]!).toBe(before);
    expect(getStatusEffects(h.world, other)).toHaveLength(0);
  });
});

describe('Verdigris Glamour — Tarnished status effect', () => {
  function applyOnce(h: Harness): void {
    h.def.resolve(h.world, {
      abilityId: h.def.abilityId,
      casterEid: h.queen,
      sourceId: mobAbilitySourceId(h.def.abilityId, h.queen),
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
      targetEid: h.player,
    });
  }

  it('applies the exact movement and attack-speed multipliers', () => {
    const h = buildHarness();
    applyOnce(h);
    const effects = getStatusEffects(h.world, h.player);
    expect(computeEffectiveValue(1, effects, 'speed')).toBeCloseTo(0.7, 10);
    expect(computeEffectiveValue(1, effects, 'attackSpeed')).toBeCloseTo(0.75, 10);
  });

  it('does not stack or refresh-stack on re-application', () => {
    const h = buildHarness();
    applyOnce(h);
    applyOnce(h);
    const effects = getStatusEffects(h.world, h.player);
    // Exactly one speed effect and one attackSpeed effect — never four.
    expect(effects.filter((e) => e.stat === 'speed')).toHaveLength(1);
    expect(effects.filter((e) => e.stat === 'attackSpeed')).toHaveLength(1);
    expect(computeEffectiveValue(1, effects, 'speed')).toBeCloseTo(0.7, 10);
    expect(computeEffectiveValue(1, effects, 'attackSpeed')).toBeCloseTo(0.75, 10);
  });

  it('does not stack across different casters of the same ability', () => {
    const h = buildHarness();
    // A second Queen casts the same ability at the same player. Tarnished is a
    // singleton debuff by identity, so the second cast must REPLACE the first's
    // multipliers, never compound them (0.70 * 0.70 would be a stacking bug).
    const queen2 = spawnBehaviorEnemy(h.world, 60, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    const applyFrom = (caster: number): void =>
      h.def.resolve(h.world, {
        abilityId: h.def.abilityId,
        casterEid: caster,
        sourceId: mobAbilitySourceId(h.def.abilityId, caster),
        geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 12 },
        targetEid: h.player,
      });
    applyFrom(h.queen);
    applyFrom(queen2);
    const effects = getStatusEffects(h.world, h.player);
    expect(effects.filter((e) => e.stat === 'speed')).toHaveLength(1);
    expect(effects.filter((e) => e.stat === 'attackSpeed')).toHaveLength(1);
    expect(computeEffectiveValue(1, effects, 'speed')).toBeCloseTo(0.7, 10);
    expect(computeEffectiveValue(1, effects, 'attackSpeed')).toBeCloseTo(0.75, 10);
  });

  it('clears Tarnished after the target dies from a later source', () => {
    const h = buildHarness();
    applyOnce(h);
    expect(getStatusEffects(h.world, h.player)).toHaveLength(2);

    h.world.stores.health.current[h.player] = 0;
    healthSystem(h.world);

    expect(getStatusEffects(h.world, h.player)).toHaveLength(0);
    expect(h.world.state).toBe('game_over');

    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    expect(h.world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('expires after its 4-second duration', () => {
    const h = buildHarness();
    applyOnce(h);
    expect(getStatusEffects(h.world, h.player).length).toBe(2);
    // 4,000ms / DELTA ≈ 240 steps; add a margin.
    step(h.world, 245);
    expect(getStatusEffects(h.world, h.player)).toHaveLength(0);
  });
});

describe('Verdigris Glamour — announcement dedup', () => {
  it('emits the exact announcement exactly once per cast', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, SECOND_RESOLUTION_FRAME + 5);
    const casts = h.world.announcements.filter((a) => a.kind === 'bossAbilityCast');
    expect(casts).toHaveLength(2);
    for (const a of casts) {
      expect(a.text).toBe(EXPECTED_ANNOUNCEMENT);
    }
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.announcementsEmitted).toBe(2);
    expect(inst.resolvedCasts).toBe(2);
  });
});

describe('Verdigris Glamour — cleanup paths', () => {
  it('releases all state when the caster dies', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    h.world.stores.health.current[h.queen] = 0;
    step(h.world, 1);
    expect(h.world.mobAbilities.byEntity.has(h.queen)).toBe(false);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
    expect(h.world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('releases all state when the caster despawns', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    removeEntity(h.world.ecs, h.queen);
    step(h.world, 1);
    expect(h.world.mobAbilities.byEntity.has(h.queen)).toBe(false);
    expect(h.world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('releases all state when the encounter is disabled', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    disableMobAbilityEncounter(h.world);
    expect(h.world.mobAbilities.byEntity.size).toBe(0);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
    expect(h.world.mobAbilities.encounterActive).toBe(false);
    expect(h.world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('releases owned Tarnished effects and instance when the id is recycled', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME);
    const sourceId = mobAbilitySourceId(h.def.abilityId, h.queen);
    expect(getStatusEffects(h.world, h.player).some((e) => e.sourceId === sourceId)).toBe(true);
    // Recycle the id: the slot now carries a different boss identity.
    setEnemyAppearanceKey(h.world, h.queen, 'some-other-boss');
    step(h.world, 1);
    expect(h.world.mobAbilities.byEntity.has(h.queen)).toBe(false);
    expect(getStatusEffects(h.world, h.player).some((e) => e.sourceId === sourceId)).toBe(false);
  });

  it('clearMobAbility releases owned effects for an arbitrary caster', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME);
    const sourceId = mobAbilitySourceId(h.def.abilityId, h.queen);
    expect(getStatusEffects(h.world, h.player).some((e) => e.sourceId === sourceId)).toBe(true);
    clearMobAbility(h.world, h.queen);
    expect(getStatusEffects(h.world, h.player).some((e) => e.sourceId === sourceId)).toBe(false);
  });

  it('skips the cast (no telegraph, no announcement) when the target is invalid', () => {
    const h = buildHarness();
    arm(h);
    // Remove the only player before the first eligibility fires.
    removeEntity(h.world.ecs, h.player);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.phase).toBe('cooldown');
    expect(inst.announcementsEmitted).toBe(0);
    expect(h.world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('treats a dead target as invalid — no telegraph or announcement', () => {
    const h = buildHarness();
    arm(h);
    // The player is present but dead when eligibility fires: it must not anchor
    // a telegraph. The boss re-arms instead of firing a phantom cast.
    h.world.stores.health.current[h.player] = 0;
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.phase).toBe('cooldown');
    expect(inst.announcementsEmitted).toBe(0);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
    expect(h.world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('skips resolution if the locked target dies during the telegraph', () => {
    const h = buildHarness();
    arm(h);
    // Telegraph starts successfully at frame 540.
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.phase).toBe('telegraph');
    expect(inst.committedTargetEid).toBe(h.player);
    expect(inst.announcementsEmitted).toBe(1);
    // Kill the player mid-telegraph (before resolution at frame 630).
    h.world.stores.health.current[h.player] = 0;
    // Step to resolution frame: the runtime revalidates the target and skips
    // the resolve call (no Tarnished applied), but still re-arms cooldown.
    step(h.world, FIRST_RESOLUTION_FRAME + 5);
    expect(inst.phase).toBe('cooldown');
    expect(inst.resolvedCasts).toBe(0); // No resolve call happened.
    const playerEffects = getStatusEffects(h.world, h.player);
    expect(playerEffects).toHaveLength(0); // No Tarnished applied to the dead player.
  });

  it('skips resolution if the locked target eid is recycled into a non-player entity', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.phase).toBe('telegraph');
    expect(inst.committedTargetEid).toBe(h.player);

    removeEntity(h.world.ecs, h.player);
    const recycled = spawnBehaviorEnemy(h.world, 40, 40, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    expect(recycled).toBe(h.player);

    step(h.world, FIRST_RESOLUTION_FRAME + 5);

    expect(inst.phase).toBe('cooldown');
    expect(inst.resolvedCasts).toBe(0);
    expect(getStatusEffects(h.world, recycled)).toHaveLength(0);
  });

  it('skips resolution if the locked target eid is recycled into a new player', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    const inst = h.world.mobAbilities.byEntity.get(h.queen)!;
    expect(inst.phase).toBe('telegraph');
    expect(inst.committedTargetEid).toBe(h.player);
    const lockedGeneration = inst.committedTargetGeneration;

    removeEntity(h.world.ecs, h.player);
    const recycledPlayer = spawnPlayer(h.world, 40, 40);
    expect(recycledPlayer).toBe(h.player);
    expect(h.world.entityRenderGeneration[recycledPlayer]).not.toBe(lockedGeneration);
    const recycledHealth = h.world.stores.health.current[recycledPlayer]!;

    step(h.world, FIRST_RESOLUTION_FRAME - (FIRST_TELEGRAPH_FRAME + 5));

    expect(inst.phase).toBe('cooldown');
    expect(inst.resolvedCasts).toBe(0);
    expect(h.world.stores.health.current[recycledPlayer]).toBe(recycledHealth);
    expect(getStatusEffects(h.world, recycledPlayer)).toHaveLength(0);
  });

  it('setMobAbilitiesEnabled(false) tears down the runtime', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    setMobAbilitiesEnabled(h.world, false);
    expect(h.world.mobAbilities.enabled).toBe(false);
    expect(h.world.mobAbilities.byEntity.size).toBe(0);
  });
});

describe('Verdigris Glamour — canonical simulation pipeline', () => {
  it('the DEFAULT normal-game configuration records zero casts/events over 21s', () => {
    // Same canonical pipeline, but the runtime gate is never enabled and no
    // ability is registered — exactly the real game's default.
    const world = createTestWorld();
    const player = spawnPlayer(world, 40, 40);
    world.stores.health.current[player] = 100_000;
    // Even with Queen Mab present, nothing fires while the gate is off.
    const queen = spawnBehaviorEnemy(world, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    setEnemyAppearanceKey(world, queen, QUEEN_KEY);
    const inputState = createInputState();

    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 30; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      runCoreSimulationStep(world, inputState, {
        preSystems: [weaponSystem, enemyAISystem, mobAbilitySystem],
      });
    }

    expect(world.mobAbilities.enabled).toBe(false);
    expect(world.mobAbilities.byEntity.size).toBe(0);
    expect(world.mobAbilities.cues).toHaveLength(0);
    expect(world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('the arena configuration records two casts through the canonical runtime', () => {
    const world = createTestWorld();
    const roomPreset = getRoomPreset('medium-arena');
    world.floorMap = roomPreset.buildMap();
    const spawnWorld = world.floorMap.tileToWorld(
      roomPreset.playerSpawnTile.x,
      roomPreset.playerSpawnTile.y,
    );
    const player = spawnPlayer(world, spawnWorld.x, spawnWorld.y);
    world.stores.health.current[player] = 100_000;
    world.stores.health.max[player] = 100_000;
    const preset = getEnemyPreset('f2-queen-mab');
    const rng = new SeededRandom(42);
    const cx = world.floorMap.widthFt / 2;
    const cy = world.floorMap.heightFt * 0.35;
    const spawned = spawnPresetAroundCenter(world, world.floorMap, preset, cx, cy, rng, 14);
    const queen = spawned[0];
    expect(queen).toBeDefined();
    const inputState = createInputState();

    const resolutionFrames: number[] = [];
    let prevResolved = 0;
    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 30; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      runCoreSimulationStep(world, inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
      const inst = world.mobAbilities.byEntity.get(queen!);
      if (inst && inst.resolvedCasts > prevResolved) {
        resolutionFrames.push(world.frameCount);
        prevResolved = inst.resolvedCasts;
      }
    }

    expect(resolutionFrames).toEqual([FIRST_RESOLUTION_FRAME, SECOND_RESOLUTION_FRAME]);
    expect(world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(2);
  });

  it('ticks Tarnished to expiry through the arena preSystems ordering', () => {
    // Guards the arena preSystems composition: statusEffectSystem MUST run in the
    // same canonical loop as mobAbilitySystem, or Tarnished never expires in the
    // live arena. Drive the exact arena ordering and prove the debuff both lands
    // at resolution and clears after its 4s authored duration.
    const world = createTestWorld();
    const player = spawnPlayer(world, 40, 40);
    world.stores.health.current[player] = 100_000;
    world.stores.health.max[player] = 100_000;
    const queen = spawnBehaviorEnemy(world, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    setEnemyAppearanceKey(world, queen, QUEEN_KEY);
    setMobAbilitiesEnabled(world, true);
    registerMobAbility(world, queen, createVerdigrisGlamourDefinition());
    activateMobAbilityEncounter(world);
    const inputState = createInputState();
    const sourceId = mobAbilitySourceId(VERDIGRIS_GLAMOUR_ABILITY_ID, queen);
    const tarnishedCount = (): number =>
      getStatusEffects(world, player).filter((e) => e.sourceId === sourceId).length;

    const stepArena = (frames: number): void => {
      for (let i = 0; i < frames; i += 1) {
        world.frameCount += 1;
        world.elapsedMs += DELTA;
        runCoreSimulationStep(world, inputState, {
          preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
        });
      }
    };

    // Just past the first resolution (frame 630): Tarnished is applied.
    stepArena(FIRST_RESOLUTION_FRAME + 1);
    expect(tarnishedCount()).toBeGreaterThan(0);
    // ~4,000ms (≈240 frames, +margin) after resolution the debuff must be gone,
    // and this is comfortably before the second telegraph (frame 1170) so no
    // re-application masks the expiry.
    stepArena(245);
    expect(tarnishedCount()).toBe(0);
  });
});

describe('Verdigris Glamour — pendingBursts durable queue', () => {
  it('populates pendingBursts at resolution so burst survives caster teardown', () => {
    // Regression: the old approach read burst count from runtime.byEntity, which
    // clearMobAbility empties before PhaserBridge.sync; if the caster died in the
    // same step as the resolution, the burst was lost. Now resolveCast pushes
    // geometry to pendingBursts so the queue is non-empty regardless of caster
    // liveness when the VFX renderer runs.
    const world = createTestWorld();
    const player = spawnPlayer(world, 40, 40);
    world.stores.health.current[player] = 100_000;
    world.stores.health.max[player] = 100_000;
    const queen = spawnBehaviorEnemy(world, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    setEnemyAppearanceKey(world, queen, QUEEN_KEY);
    setMobAbilitiesEnabled(world, true);
    registerMobAbility(world, queen, createVerdigrisGlamourDefinition());
    activateMobAbilityEncounter(world);
    const inputState = createInputState();

    // Advance to just before the first resolution frame.
    for (let i = 0; i < FIRST_RESOLUTION_FRAME - 1; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      runCoreSimulationStep(world, inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
    }
    expect(world.mobAbilities.pendingBursts).toHaveLength(0);

    // Run the resolution frame — pendingBursts is populated by resolveCast.
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    runCoreSimulationStep(world, inputState, {
      preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
    });
    expect(world.mobAbilities.pendingBursts).toHaveLength(1);
    expect(world.mobAbilities.pendingBursts[0]).toMatchObject({
      kind: 'resolution',
      abilityId: VERDIGRIS_GLAMOUR_ABILITY_ID,
      geometry: { kind: 'circle' },
    });

    // Simulate caster teardown (byEntity cleared) — pendingBursts is unaffected.
    clearMobAbility(world, queen);
    expect(world.mobAbilities.byEntity.has(queen)).toBe(false);
    expect(world.mobAbilities.pendingBursts).toHaveLength(1);
  });
});

describe('weaponSystem — zero attackSpeed multiplier', () => {
  it('a 0× attackSpeed status prevents weapon firing (cooldown becomes Infinity)', () => {
    // Regression: the old `attackSpeedMult > 0 && attackSpeedMult !== 1` guard
    // skipped the zero branch (0 > 0 is false), so the weapon still fired at
    // baseline rate even with a zero-multiplier debuff. Now attackSpeedMult <= 0
    // sets the effective cooldown to Infinity so no projectile is ever fired.
    const world = createTestWorld();
    const player = spawnPlayer(world, 40, 40);
    world.stores.health.current[player] = 100_000;
    world.stores.health.max[player] = 100_000;
    // Spawn an enemy in auto-aim range (COMBAT_RADIUS_FT = 150) but far enough
    // away that the collisionSystem never generates a damage event for them.
    spawnBehaviorEnemy(world, 80, 40, 200, AI_TYPE.CHASE, 0.17, 60, 0);

    // Apply a 0× attackSpeed status effect (persistent, never expires).
    applyStatusEffect(world, player, {
      stat: 'attackSpeed',
      op: 'multiply',
      value: 0,
      durationMs: null,
      stackRule: { mode: 'replace' },
      sourceType: 'debug',
      sourceId: 'test:zero-attack-speed',
    });

    const inputState = createInputState();
    // Snapshot events before the loop; the weapon-system-only pipeline runs
    // no collision/damage ticks, so all new events must come from weaponSystem.
    const eventsBefore = world.combatEvents.length;

    // Run 120 frames (~2s) — well above any normal weapon cooldown.
    for (let i = 0; i < 120; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      runCoreSimulationStep(world, inputState, {
        preSystems: [weaponSystem],
      });
    }

    // No combat events should have been emitted; the weapon never fired.
    expect(world.combatEvents.length).toBe(eventsBefore);
  });
});

describe('disableMobAbilityEncounter — pendingBursts teardown', () => {
  it('clears pendingBursts on global encounter teardown', () => {
    // Regression: disableMobAbilityEncounter previously left pendingBursts
    // intact; if teardown raced the render sync the old burst would appear in
    // the new scene context.
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME);
    // After resolution, pendingBursts should have one entry.
    expect(h.world.mobAbilities.pendingBursts.length).toBeGreaterThan(0);
    // Disabling the encounter must drain the burst queue.
    disableMobAbilityEncounter(h.world);
    expect(h.world.mobAbilities.pendingBursts).toHaveLength(0);
    expect(h.world.mobAbilities.encounterActive).toBe(false);
    expect(h.world.mobAbilities.byEntity.size).toBe(0);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
  });
});

describe('healthSystem — dead-caster mob-ability cleanup', () => {
  it('clears in-flight cue for a boss with DeathTimer (corpse linger) in the same tick as death', () => {
    // Regression: a boss killed later in the same step as mobAbilitySystem ran
    // reached the DeathTimer early-return in healthSystem without clearing its
    // ability cue, leaving a stale telegraph visible until the next step.
    // Now healthSystem calls clearMobAbility before the DeathTimer continue so
    // cues are always clean even for lingering corpses.
    const world = createTestWorld();
    const player = spawnPlayer(world, 40, 40);
    world.stores.health.current[player] = 100_000;
    world.stores.health.max[player] = 100_000;
    const queen = spawnBehaviorEnemy(world, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    setEnemyAppearanceKey(world, queen, QUEEN_KEY);
    setMobAbilitiesEnabled(world, true);
    registerMobAbility(world, queen, createVerdigrisGlamourDefinition());
    activateMobAbilityEncounter(world);

    // Advance to the telegraph phase so there is an active cue.
    step(world, FIRST_TELEGRAPH_FRAME + 5);
    expect(world.mobAbilities.cues).toHaveLength(1);
    expect(world.mobAbilities.byEntity.has(queen)).toBe(true);

    // Simulate the boss dying but lingering (DeathTimer attached, HP=0).
    world.stores.health.current[queen] = 0;
    addComponent(world.ecs, queen, set(DeathTimer, { remainingMs: 1500 }));

    // Run healthSystem — the dead caster's ability state must be cleared.
    healthSystem(world);
    expect(world.mobAbilities.byEntity.has(queen)).toBe(false);
    expect(world.mobAbilities.cues).toHaveLength(0);
  });
});
