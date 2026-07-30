import { describe, expect, it } from 'vitest';
import { removeEntity } from 'bitecs';
import { createTestWorld } from '../../helpers/world-factory.js';
import { GAME } from '../../../src/shared/constants.js';
import { createInputState } from '../../../src/shared/input.js';
import {
  activateMobAbilityEncounter,
  clearMobAbility,
  createClockworkKillSawDefinition,
  disableMobAbilityEncounter,
  mobAbilitySystem,
  registerMobAbility,
  setEnemyAppearanceKey,
  setMobAbilitiesEnabled,
  spawnBehaviorEnemy,
  spawnPlayer,
  statusEffectSystem,
  type MobAbilityRuntimeDefinition,
} from '../../../src/core/index.js';
import { runCoreSimulationStep } from '../../../src/core/simulation-core-step.js';
import { enemyAISystem, weaponSystem } from '../../../src/game/index.js';
import { AI_TYPE } from '../../../src/game/enemyAISystem.js';
import {
  ARENA_OBSERVER_PLAYER_HP,
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
} from '../../../src/labs/combat-arena-lab/arena-data.js';
import { SeededRandom } from '../../../src/shared/random.js';

const DELTA = GAME.DELTA_MS;
const FIZZWICK_KEY = 'gnome-boss';
const EXPECTED_ANNOUNCEMENT = 'CLOCKWORK KILL-SAW — Mandatory overtime starts now!';
const FIRST_TELEGRAPH_FRAME = 540;
const FIRST_LAUNCH_FRAME = 618;
const FIRST_OUTBOUND_FRAME = 619;
const FIRST_HOLD_FRAME = 650;
const FIRST_RETURN_FRAME = 668;
const FIRST_RECATCH_FRAME = 700;
const SECOND_TELEGRAPH_FRAME = 1240;
const SECOND_RECATCH_FRAME = 1400;

type World = ReturnType<typeof createTestWorld>;

interface Harness {
  world: World;
  player: number;
  fizzwick: number;
  def: MobAbilityRuntimeDefinition;
}

function buildHarness(px = 40, py = 50, fx = 40, fy = 10): Harness {
  const world = createTestWorld({ seed: 42 });
  const player = spawnPlayer(world, px, py);
  world.stores.health.current[player] = 100_000;
  world.stores.health.max[player] = 100_000;
  const fizzwick = spawnBehaviorEnemy(world, fx, fy, 240, AI_TYPE.RANGED, 0.1, 65, 16);
  setEnemyAppearanceKey(world, fizzwick, FIZZWICK_KEY);
  const def = createClockworkKillSawDefinition();
  return { world, player, fizzwick, def };
}

function arm(h: Harness): void {
  setMobAbilitiesEnabled(h.world, true);
  registerMobAbility(h.world, h.fizzwick, h.def);
  activateMobAbilityEncounter(h.world);
}

function step(world: World, frames: number): void {
  for (let i = 0; i < frames; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    statusEffectSystem(world);
    mobAbilitySystem(world);
  }
}

function firstCue(h: Harness) {
  return h.world.mobAbilities.cues[0]!;
}

describe('Clockwork Kill-Saw — typed definition', () => {
  it('derives the exact catalog contract', () => {
    const def = createClockworkKillSawDefinition();
    expect(def.abilityId).toBe('overseer-fizzwick-clockwork-kill-saw');
    expect(def.bossArchetypeKey).toBe(FIZZWICK_KEY);
    expect(def.firstEligibleAfterMs).toBe(9000);
    expect(def.cooldownMs).toBe(9000);
    expect(def.telegraphDurationMs).toBe(1300);
    expect(def.dangerColor).toBe('hostile-red');
    expect(def.announcementText).toBe(EXPECTED_ANNOUNCEMENT);
    expect(def.geometry).toEqual({ kind: 'lane', widthFt: 6, maxRangeFt: 32 });
    expect(def.activeEffect).toMatchObject({
      kind: 'returning-lane',
      holdMs: 300,
      speedFtPerTick: 1,
      damageAmount: 20,
    });
  });
});

describe('Clockwork Kill-Saw — cadence and lock', () => {
  it('locks one 6ft lane toward the player and never retargets after telegraph start', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME);
    const cue = firstCue(h);
    expect(cue.phase).toBe('telegraph');
    expect(cue.geometry.kind).toBe('lane');
    const lane = cue.geometry;
    if (lane.kind !== 'lane') {
      throw new Error('expected committed lane geometry');
    }
    expect(lane.originX).toBe(40);
    expect(lane.originY).toBe(10);
    expect(lane.endX).toBe(40);
    expect(lane.endY).toBe(42);
    expect(lane.widthFt).toBe(6);
    expect(lane.lengthFt).toBe(32);

    h.world.stores.position.x[h.player] = 80;
    h.world.stores.position.y[h.player] = 90;
    step(h.world, 10);
    const lockedCue = firstCue(h);
    expect(lockedCue.geometry).toEqual(lane);
  });

  it('holds for 300ms at the endpoint, then returns, and only starts cooldown after re-catch', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_LAUNCH_FRAME);
    const launchCue = firstCue(h);
    expect(launchCue.phase).toBe('outbound');
    expect(launchCue.projectileX).toBeCloseTo(40, 6);
    expect(launchCue.projectileY).toBeCloseTo(10, 6);

    step(h.world, FIRST_OUTBOUND_FRAME - FIRST_LAUNCH_FRAME);
    expect(firstCue(h).phase).toBe('outbound');
    step(h.world, FIRST_HOLD_FRAME - FIRST_OUTBOUND_FRAME);
    const holdCue = firstCue(h);
    expect(holdCue.phase).toBe('hold');
    expect(holdCue.projectileX).toBeCloseTo(40, 6);
    expect(holdCue.projectileY).toBeCloseTo(42, 6);

    step(h.world, FIRST_RETURN_FRAME - FIRST_HOLD_FRAME);
    expect(firstCue(h).phase).toBe('return');

    step(h.world, FIRST_RECATCH_FRAME - FIRST_RETURN_FRAME);
    const inst = h.world.mobAbilities.byEntity.get(h.fizzwick)!;
    expect(inst.phase).toBe('cooldown');
    expect(inst.resolvedCasts).toBe(1);
    expect(inst.timerMs).toBeCloseTo(9000, 0);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
  });

  it('records two fully resolved casts at fixed cadence anchored after return', () => {
    const h = buildHarness();
    arm(h);
    const telegraphs: number[] = [];
    const resolves: number[] = [];
    let prevAnnouncements = 0;
    let prevResolved = 0;
    for (let i = 0; i < SECOND_RECATCH_FRAME + 5; i += 1) {
      h.world.frameCount += 1;
      h.world.elapsedMs += DELTA;
      statusEffectSystem(h.world);
      mobAbilitySystem(h.world);
      const casts = h.world.announcements.filter((a) => a.kind === 'bossAbilityCast').length;
      if (casts > prevAnnouncements) {
        telegraphs.push(h.world.frameCount);
        prevAnnouncements = casts;
      }
      const inst = h.world.mobAbilities.byEntity.get(h.fizzwick)!;
      if (inst.resolvedCasts > prevResolved) {
        resolves.push(h.world.frameCount);
        prevResolved = inst.resolvedCasts;
      }
    }
    expect(telegraphs).toEqual([FIRST_TELEGRAPH_FRAME, SECOND_TELEGRAPH_FRAME]);
    expect(resolves).toEqual([FIRST_RECATCH_FRAME, SECOND_RECATCH_FRAME]);
  });

  it('keeps the public cue continuous through telegraph resolution into launch', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_LAUNCH_FRAME);
    expect(h.world.mobAbilities.cues).toHaveLength(1);
    expect(firstCue(h).phase).toBe('outbound');
  });
});

describe('Clockwork Kill-Saw — per-pass damage semantics', () => {
  it('damages once on outbound and once on return, without frame-repeat hits', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_OUTBOUND_FRAME);
    h.world.stores.position.x[h.player] = 40;
    h.world.stores.position.y[h.player] = 24;
    const before = h.world.stores.health.current[h.player]!;
    step(h.world, FIRST_RECATCH_FRAME - FIRST_OUTBOUND_FRAME + 5);
    const after = h.world.stores.health.current[h.player]!;
    expect(before - after).toBe(40);
  });

  it('lets a target enter after lock for outbound, leave, then re-enter for the return pass', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_OUTBOUND_FRAME);
    h.world.stores.position.x[h.player] = 40;
    h.world.stores.position.y[h.player] = 24;
    const before = h.world.stores.health.current[h.player]!;
    step(h.world, 15);
    const afterOutbound = h.world.stores.health.current[h.player]!;
    expect(before - afterOutbound).toBe(20);
    h.world.stores.position.x[h.player] = 80;
    h.world.stores.position.y[h.player] = 80;
    step(h.world, 35);
    h.world.stores.position.x[h.player] = 40;
    h.world.stores.position.y[h.player] = 24;
    step(h.world, FIRST_RECATCH_FRAME - FIRST_OUTBOUND_FRAME - 50);
    expect(before - (h.world.stores.health.current[h.player] ?? 0)).toBe(40);
  });
});

describe('Clockwork Kill-Saw — announcements and cleanup', () => {
  it('announces exactly once per cast', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, SECOND_RECATCH_FRAME + 5);
    const casts = h.world.announcements.filter((a) => a.kind === 'bossAbilityCast');
    expect(casts).toHaveLength(2);
    expect(casts.every((a) => a.text === EXPECTED_ANNOUNCEMENT)).toBe(true);
  });

  it('cleans all state when the caster dies during an active return', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RETURN_FRAME + 1);
    h.world.stores.health.current[h.fizzwick] = 0;
    step(h.world, 1);
    expect(h.world.mobAbilities.byEntity.has(h.fizzwick)).toBe(false);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
  });

  it('enters cooldown (preserving registration) when the target despawns during an active cast', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_HOLD_FRAME);
    removeEntity(h.world.ecs, h.player);
    step(h.world, 1);
    // beginCooldownAfterActive re-arms the ability instead of removing it, so the
    // registration survives — Fizzwick can cast again after cooldown.
    expect(h.world.mobAbilities.byEntity.has(h.fizzwick)).toBe(true);
    const inst = h.world.mobAbilities.byEntity.get(h.fizzwick)!;
    expect(inst.phase).toBe('cooldown');
    expect(h.world.mobAbilities.cues).toHaveLength(0);
  });

  it('cleans all state when the encounter is disabled or manually cleared', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_OUTBOUND_FRAME);
    disableMobAbilityEncounter(h.world);
    expect(h.world.mobAbilities.byEntity.size).toBe(0);
    expect(h.world.mobAbilities.cues).toHaveLength(0);

    arm(h);
    step(h.world, FIRST_OUTBOUND_FRAME);
    clearMobAbility(h.world, h.fizzwick);
    expect(h.world.mobAbilities.byEntity.has(h.fizzwick)).toBe(false);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
  });
});

describe('Clockwork Kill-Saw — canonical simulation pipeline', () => {
  it('default normal-game configuration records zero casts over the same duration', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 40, 50);
    world.stores.health.current[player] = ARENA_OBSERVER_PLAYER_HP;
    world.stores.health.max[player] = ARENA_OBSERVER_PLAYER_HP;
    const fizzwick = spawnBehaviorEnemy(world, 40, 10, 240, AI_TYPE.RANGED, 0.1, 65, 16);
    setEnemyAppearanceKey(world, fizzwick, FIZZWICK_KEY);
    const input = createInputState();

    for (let i = 0; i < SECOND_RECATCH_FRAME + 30; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      runCoreSimulationStep(world, input, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
    }

    expect(world.mobAbilities.enabled).toBe(false);
    expect(world.mobAbilities.byEntity.size).toBe(0);
    expect(world.mobAbilities.cues).toHaveLength(0);
    expect(world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('arena preset records two fully resolved casts through the canonical runtime', () => {
    const world = createTestWorld({ seed: 42 });
    const roomPreset = getRoomPreset('boss-arena');
    world.floorMap = roomPreset.buildMap();
    const spawnWorld = world.floorMap.tileToWorld(
      roomPreset.playerSpawnTile.x,
      roomPreset.playerSpawnTile.y,
    );
    const player = spawnPlayer(world, spawnWorld.x, spawnWorld.y);
    world.stores.health.current[player] = ARENA_OBSERVER_PLAYER_HP;
    world.stores.health.max[player] = ARENA_OBSERVER_PLAYER_HP;
    const preset = getEnemyPreset('f2-overseer-fizzwick');
    const rng = new SeededRandom(42);
    const cx = world.floorMap.widthFt / 2;
    const cy = world.floorMap.heightFt * 0.35;
    const spawned = spawnPresetAroundCenter(world, world.floorMap, preset, cx, cy, rng, 14);
    expect(spawned[0]).toBeDefined();
    const input = createInputState();

    const telegraphs: number[] = [];
    const resolves: number[] = [];
    let prevAnnouncements = 0;
    let prevResolved = 0;
    for (let i = 0; i < SECOND_RECATCH_FRAME + 30; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      runCoreSimulationStep(world, input, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
      const castCount = world.announcements.filter((a) => a.kind === 'bossAbilityCast').length;
      if (castCount > prevAnnouncements) {
        telegraphs.push(world.frameCount);
        prevAnnouncements = castCount;
      }
      const inst = world.mobAbilities.byEntity.get(spawned[0]!)!;
      if (inst.resolvedCasts > prevResolved) {
        resolves.push(world.frameCount);
        prevResolved = inst.resolvedCasts;
      }
    }

    expect(telegraphs).toEqual([FIRST_TELEGRAPH_FRAME, SECOND_TELEGRAPH_FRAME]);
    expect(resolves).toEqual([FIRST_RECATCH_FRAME, SECOND_RECATCH_FRAME]);
  });
});
