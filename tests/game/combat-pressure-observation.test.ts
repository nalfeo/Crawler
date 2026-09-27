import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { DeathTimer, EnemyBehavior, FamilyMembership, Team } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { adjustFactionRelation, asFamilyId } from '../../src/core/faction-relations.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { BiomeType, TilePresets } from '../../src/shared/map-types.js';
import { TeamId } from '../../src/shared/constants.js';
import { observeCombatPressure } from '../../src/game/ai/combat-pressure-observation.js';
import { createPlayerSessionRecorder } from '../../src/game/ai/player-session-recorder.js';
import { collectHumanRunStats } from '../../src/game/ai/run-stats-collector.js';
import { createTestWorld } from '../helpers/world-factory.js';

function fixture() {
  const world = createTestWorld({ seed: 4711 });
  const player = spawnPlayer(world, 100, 100);
  const enemy = (x: number, attackRange = 0) => {
    const eid = spawnEnemy(world, x, 100, 50);
    addComponent(
      world.ecs,
      eid,
      set(EnemyBehavior, {
        type: 0,
        speed: 1,
        aggroRange: 100,
        attackRange,
        aggroEnableAtMs: 0,
      }),
    );
    return eid;
  };
  return { world, player, enemy };
}

const idleInput = { moveX: 0, moveY: 0, action: false, pointerX: 0, pointerY: 0 };

describe('combat pressure world observations', () => {
  it('distinguishes nearby threats from enemies elsewhere on the floor', () => {
    const { world, player, enemy } = fixture();
    const eid = enemy(150);
    expect(observeCombatPressure(world, player)).toMatchObject({
      valid: true,
      localThreatCount: 0,
    });
    world.stores.position.x[eid] = 110;
    expect(observeCombatPressure(world, player).localThreatCount).toBe(1);
  });

  it('uses authored ranged reach but caps the local radius at 32 feet', () => {
    const { world, player, enemy } = fixture();
    enemy(124, 25);
    enemy(133, 100);
    expect(observeCombatPressure(world, player).localThreatCount).toBe(1);
  });

  it('excludes nearby enemies behind opaque walls', () => {
    const { world, player, enemy } = fixture();
    const tileMap = new TileMap(40, 40);
    tileMap.flags.fill(TilePresets.FLOOR);
    world.floorMap = new FloorMap(
      {
        widthTiles: 40,
        heightTiles: 40,
        tileSizeFt: 4,
        biome: BiomeType.ARENA,
        seed: 4711,
        roomWidthRange: [4, 8],
        roomHeightRange: [4, 8],
        maxRooms: 1,
        floorDensity: 1,
      },
      tileMap,
      new RoomGraph(),
      new Uint8Array(1600),
      { x: 1, y: 1 },
    );
    enemy(110);
    expect(observeCombatPressure(world, player).localThreatCount).toBe(1);
    tileMap.flags[25 * 40 + 26] = TilePresets.WALL;
    expect(observeCombatPressure(world, player).localThreatCount).toBe(0);
  });

  it('excludes safe-room observations and explicit transition safe intervals', () => {
    const { world, player, enemy } = fixture();
    enemy(105);
    world.playerInSafeRoom = true;
    expect(observeCombatPressure(world, player)).toMatchObject({ safe: true, localThreatCount: 0 });
    world.playerInSafeRoom = false;
    expect(observeCombatPressure(world, player, true).safe).toBe(true);
    expect(observeCombatPressure(world, player).localThreatCount).toBe(1);
  });

  it('excludes delayed aggro, corpses and enemies outside their aggro range', () => {
    const { world, player, enemy } = fixture();
    const delayed = enemy(105);
    world.stores.enemyBehavior.aggroEnableAtMs[delayed] = 1000;
    const corpse = enemy(106);
    addComponent(world.ecs, corpse, DeathTimer);
    const dead = enemy(107);
    world.stores.health.current[dead] = 0;
    const unaware = enemy(110);
    world.stores.enemyBehavior.aggroRange[unaware] = 5;
    expect(observeCombatPressure(world, player).localThreatCount).toBe(0);
    world.elapsedMs = 1000;
    expect(observeCombatPressure(world, player).localThreatCount).toBe(1);
  });

  it('excludes player-team allies and neutral family mobs', () => {
    const { world, player, enemy } = fixture();
    const ally = enemy(105);
    addComponent(world.ecs, ally, set(Team, { id: TeamId.PLAYER }));
    const neutral = enemy(106);
    adjustFactionRelation(world, asFamilyId('__slot:0'), 5);
    addComponent(world.ecs, neutral, set(FamilyMembership, { familyId: 0, isBoss: 0 }));
    expect(observeCombatPressure(world, player).localThreatCount).toBe(0);
  });

  it('marks invalid player observations unmeasured instead of reporting quiet combat', () => {
    const { world, player } = fixture();
    world.stores.position.x[player] = Number.NaN;
    expect(observeCombatPressure(world, player).valid).toBe(false);
  });

  it('records fatal net health loss from a valid terminal endpoint', () => {
    const { world, player, enemy } = fixture();
    enemy(105);
    const initialHealth = world.stores.health.current[player]!;
    const recorder = createPlayerSessionRecorder(world, player);
    world.elapsedMs = 100;
    world.stores.health.current[player] = 0;
    world.state = 'game_over';
    recorder.tick(idleInput);
    expect(observeCombatPressure(world, player).valid).toBe(true);
    expect(recorder.getStats().combatPressure).toMatchObject({
      status: 'measured',
      netHealthLoss: initialHealth,
      peakNetHealthLoss1s: initialHealth,
    });
  });

  it('records live threat intervals and preserves evidence through human export', () => {
    const { world, player, enemy } = fixture();
    const eid = enemy(105);
    const recorder = createPlayerSessionRecorder(world, player);
    world.elapsedMs = 100;
    recorder.tick(idleInput);
    world.stores.position.x[eid] = 150;
    world.elapsedMs = 200;
    recorder.tick(idleInput);
    world.elapsedMs = 300;
    recorder.tick(idleInput);
    const stats = recorder.getStats();
    expect(stats.combatPressure).toMatchObject({ status: 'measured', observedMs: 300 });
    expect(stats.combatPressure!.threatenedMs).toBeGreaterThan(0);
    expect(stats.combatPressure!.unthreatenedMs).toBeGreaterThan(0);
    const exported = collectHumanRunStats(world, player, 'timeout', 0, stats);
    expect(exported.combatPressure).toEqual(stats.combatPressure);
    expect(exported.evaluationContext?.available.combat).toBe(false);
    expect(collectHumanRunStats(world, player, 'timeout').combatPressure).toBeUndefined();
    recorder.reset();
    expect(recorder.getStats().combatPressure?.observedMs).toBe(0);
  });
});
