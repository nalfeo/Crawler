/**
 * Tests for the deterministic AI safe-room/settlement return router.
 *
 * Covers the pure utility function (`evaluateSettlementReturnUtility`) in
 * isolation plus the full latched state machine
 * (`configureSettlementReturnRouting`/`getSettlementReturnIntent`/
 * `updateSettlementReturnIntent`): idle->armed triggering, the
 * trigger/abandon hysteresis band, armed->traveling promotion,
 * danger/unreachable aborts with their distinct cooldown windows, a
 * hysteresis-driven utility-drop defer, successful arrival through the real
 * `runSettlementMaintenancePlanner` (no stubs/mocks — this module must never
 * "cheat" its own dependency), deterministic replay, and the decision-log
 * ring-buffer cap.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { resolveFloor2SettlementAnchor } from '../../src/core/floor2-settlement-anchor.js';
import { runSettlementMaintenancePlanner } from '../../src/game/ai/settlement-maintenance-planner.js';
import { unlockAchievement } from '../../src/game/systems/achievementSystem.js';
import { isAchievementClaimed } from '../../src/core/systems/achievementRewards.js';
import type { Floor2SettlementSnapshot } from '../../src/shared/floor-types.js';
import {
  configureSettlementReturnRouting,
  evaluateSettlementReturnUtility,
  getSettlementReturnIntent,
  updateSettlementReturnIntent,
  DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
  SETTLEMENT_RETURN_DANGER_COOLDOWN_FRAMES,
  SETTLEMENT_RETURN_DECISION_LOG_CAP,
  SETTLEMENT_RETURN_DEFER_COOLDOWN_FRAMES,
  SETTLEMENT_RETURN_SERVICE_COOLDOWN_FRAMES,
  SETTLEMENT_RETURN_UNREACHABLE_COOLDOWN_FRAMES,
  type SettlementReturnIntent,
} from '../../src/game/ai/settlement-return-router.js';

type TestWorld = ReturnType<typeof createTestWorld>;

const SETTLEMENT_ROOM_ID = 0;
const TILE_SIZE_FT = 4;
// Interior cells of the SAFE room at bounds (1,1)-(4,4): all four interior
// tiles tie at squared-distance 0.5 from the bounds center (2.5,2.5);
// `resolveFloor2SettlementAnchor`'s tie-break (smallest y, then smallest x)
// picks (2,2) first, so the anchor deterministically resolves to
// `floorMap.tileToWorld(2, 2)`.
const SETTLEMENT_INTERIOR_CELLS = [
  { x: 2, y: 2 },
  { x: 2, y: 3 },
  { x: 3, y: 2 },
  { x: 3, y: 3 },
];

/**
 * Local map builder (NOT the shared `makeMapWithSafeRoom` fixture, which
 * never populates `interiorCells` and therefore can never resolve a
 * settlement anchor). 40x40 tiles at 4ft/tile comfortably covers every test
 * point used below (near/mid/far), all well within the map bounds.
 */
function makeSettlementRouterMap(): FloorMap {
  const widthTiles = 40;
  const heightTiles = 40;
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: TILE_SIZE_FT,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 4,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);
  const graph = new RoomGraph();
  graph.add(
    { x: 1, y: 1, width: 4, height: 4 },
    [],
    [],
    RoomRole.SAFE,
    undefined,
    undefined,
    SETTLEMENT_INTERIOR_CELLS,
  );
  return new FloorMap(config, tileMap, graph, new Uint8Array(widthTiles * heightTiles), {
    x: 2,
    y: 2,
  });
}

function enableFloor2Economy(world: TestWorld): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
}

function buildSettlement(
  overrides: Partial<Floor2SettlementSnapshot> = {},
): Floor2SettlementSnapshot {
  return {
    settlementRoomId: SETTLEMENT_ROOM_ID,
    settlementRoomIds: [SETTLEMENT_ROOM_ID],
    brokerEid: 1,
    defectorEid: 2,
    defectorFamilyId: 'test-family',
    defectorAppearanceKey: 'goblin-brute',
    defectorFallbackAppearanceKey: 'goblin',
    quartermasterShop: {
      archetypeId: 'quartermaster',
      npcId: 'quartermaster',
      npcEid: 3,
      inventory: [],
    },
    shops: [],
    ...overrides,
  };
}

interface RouterFixture {
  readonly world: TestWorld;
  readonly playerEid: number;
  readonly floorMap: FloorMap;
  readonly anchor: { x: number; y: number };
  readonly moveToTile: (tx: number, ty: number) => void;
  readonly moveToAnchor: () => void;
}

/** Player starts far from the settlement (tile 30,30) by default. */
function createRouterWorld(options: { seed?: number } = {}): RouterFixture {
  const { seed = 42 } = options;
  const world = createTestWorld({ seed, floor: 2 });
  enableFloor2Economy(world);
  const floorMap = makeSettlementRouterMap();
  world.floorMap = floorMap;
  const playerEid = spawnPlayer(world, 0, 0);
  world.playerLevel.level = 5;
  world.playerGold = 0;
  world.playerInSafeRoom = false;
  world.floorExtendedState = { settlement: buildSettlement() };

  const anchor = resolveFloor2SettlementAnchor(world);
  if (!anchor) throw new Error('test fixture must resolve a settlement anchor');

  const moveToTile = (tx: number, ty: number): void => {
    const pos = floorMap.tileToWorld(tx, ty);
    world.stores.position.x[playerEid] = pos.x;
    world.stores.position.y[playerEid] = pos.y;
  };
  const moveToAnchor = (): void => {
    world.stores.position.x[playerEid] = anchor.x;
    world.stores.position.y[playerEid] = anchor.y;
    world.playerInSafeRoom = true;
  };

  moveToTile(30, 30);
  return { world, playerEid, floorMap, anchor, moveToTile, moveToAnchor };
}

/** Drives exactly one `updateSettlementReturnIntent` step, advancing `world.frameCount` first. */
function tick(
  fixture: RouterFixture,
  opts: { dangerNearby?: boolean; progressSuppressed?: boolean; frameDelta?: number } = {},
): SettlementReturnIntent {
  fixture.world.frameCount += opts.frameDelta ?? 1;
  const playerX = fixture.world.stores.position.x[fixture.playerEid] ?? 0;
  const playerY = fixture.world.stores.position.y[fixture.playerEid] ?? 0;
  const anchor = resolveFloor2SettlementAnchor(fixture.world);
  return updateSettlementReturnIntent(
    fixture.world,
    fixture.playerEid,
    playerX,
    playerY,
    anchor,
    opts.dangerNearby ?? false,
    opts.progressSuppressed ?? false,
  );
}

function decisionKinds(intent: SettlementReturnIntent): string[] {
  return intent.decisions.map((d) => d.kind);
}

describe('evaluateSettlementReturnUtility (pure)', () => {
  const zeroOpportunity = {
    unclaimedAchievements: 0,
    openBossChests: 0,
    topEquipmentSwapScore: 0,
    fillableAbilitySlots: 0,
    opportunityFingerprint: '',
  };

  it('is positive when expected gain exceeds travel cost', () => {
    const score = evaluateSettlementReturnUtility(
      {
        travelDistanceFt: 10,
        opportunity: { ...zeroOpportunity, unclaimedAchievements: 1 },
        speedFtPerMs: 1,
      },
      DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
    );
    expect(score.expectedGain).toBe(40);
    expect(score.travelCost).toBe(5);
    expect(score.netUtility).toBe(35);
  });

  it('is negative when travel cost exceeds expected gain', () => {
    const score = evaluateSettlementReturnUtility(
      {
        travelDistanceFt: 200,
        opportunity: { ...zeroOpportunity, unclaimedAchievements: 1 },
        speedFtPerMs: 1,
      },
      DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
    );
    expect(score.netUtility).toBeLessThan(0);
  });

  it('is non-positive with zero opportunity regardless of distance', () => {
    const near = evaluateSettlementReturnUtility(
      { travelDistanceFt: 0, opportunity: zeroOpportunity, speedFtPerMs: 1 },
      DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
    );
    expect(near.netUtility).toBe(0);
  });

  it('sums every gain component independently', () => {
    const score = evaluateSettlementReturnUtility(
      {
        travelDistanceFt: 0,
        opportunity: {
          unclaimedAchievements: 1,
          openBossChests: 1,
          topEquipmentSwapScore: 10,
          fillableAbilitySlots: 1,
          opportunityFingerprint: 'x',
        },
        speedFtPerMs: 1,
      },
      DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
    );
    // 40 (achievement) + 60 (chest) + 10*1 (swap score) + 25 (ability slot)
    expect(score.expectedGain).toBe(135);
    expect(score.netUtility).toBe(135);
  });

  it('clamps negative opportunity counts and negative distance defensively to zero', () => {
    const score = evaluateSettlementReturnUtility(
      {
        travelDistanceFt: -50,
        opportunity: {
          unclaimedAchievements: -3,
          openBossChests: -1,
          topEquipmentSwapScore: -10,
          fillableAbilitySlots: -2,
          opportunityFingerprint: '',
        },
        speedFtPerMs: 1,
      },
      DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
    );
    expect(score.expectedGain).toBe(0);
    expect(score.travelCost).toBe(0);
    expect(score.netUtility).toBe(0);
  });

  it('is strictly monotonically decreasing in travel distance for a fixed opportunity (property)', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5 }),
        fc.nat({ max: 5 }),
        fc.nat({ max: 200 }),
        fc.nat({ max: 5 }),
        fc.float({ min: 0, max: 500, noNaN: true }),
        fc.float({ min: Math.fround(0.01), max: 500, noNaN: true }),
        (achievements, chests, swapScore, abilitySlots, distance, extraDistance) => {
          const opportunity = {
            unclaimedAchievements: achievements,
            openBossChests: chests,
            topEquipmentSwapScore: swapScore,
            fillableAbilitySlots: abilitySlots,
            opportunityFingerprint: 'p',
          };
          const nearer = evaluateSettlementReturnUtility(
            { travelDistanceFt: distance, opportunity, speedFtPerMs: 1 },
            DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
          );
          const farther = evaluateSettlementReturnUtility(
            { travelDistanceFt: distance + extraDistance, opportunity, speedFtPerMs: 1 },
            DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
          );
          expect(farther.netUtility).toBeLessThan(nearer.netUtility);
        },
      ),
    );
  });

  it('is monotonically non-decreasing in every gain component (property)', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5 }),
        fc.nat({ max: 5 }),
        fc.nat({ max: 5 }),
        fc.nat({ max: 1 }),
        (achievements, chests, abilitySlots, extraAchievement) => {
          const base = {
            unclaimedAchievements: achievements,
            openBossChests: chests,
            topEquipmentSwapScore: 0,
            fillableAbilitySlots: abilitySlots,
            opportunityFingerprint: 'p',
          };
          const more = { ...base, unclaimedAchievements: achievements + extraAchievement };
          const baseScore = evaluateSettlementReturnUtility(
            { travelDistanceFt: 10, opportunity: base, speedFtPerMs: 1 },
            DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
          );
          const moreScore = evaluateSettlementReturnUtility(
            { travelDistanceFt: 10, opportunity: more, speedFtPerMs: 1 },
            DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS,
          );
          expect(moreScore.netUtility).toBeGreaterThanOrEqual(baseScore.netUtility);
        },
      ),
    );
  });
});

describe('settlement return router state machine', () => {
  it('never arms while routing is disabled (default), even with a huge trigger-worthy opportunity', () => {
    const fixture = createRouterWorld();
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');

    // configureSettlementReturnRouting is never called.
    for (let i = 0; i < 5; i += 1) {
      const intent = tick(fixture);
      expect(intent.status).toBe('idle');
      expect(intent.decisions).toEqual([]);
    }
  });

  it('transitions idle -> armed when utility exceeds the trigger threshold (near position)', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');

    const intent = tick(fixture);
    expect(intent.status).toBe('armed');
    expect(decisionKinds(intent)).toEqual(['trigger']);
    expect(intent.lastUtility?.netUtility ?? 0).toBeGreaterThan(
      DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS.triggerThreshold,
    );
  });

  it('stays idle in the hysteresis band (mid position: utility between abandon and trigger thresholds)', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(12, 12);
    unlockAchievement(fixture.world, 'first-bonk');

    const intent = tick(fixture);
    expect(intent.status).toBe('idle');
    expect(intent.decisions).toEqual([]);
  });

  it('stays idle when utility is negative (far position)', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(30, 30);
    unlockAchievement(fixture.world, 'first-bonk');

    const intent = tick(fixture);
    expect(intent.status).toBe('idle');
    expect(intent.decisions).toEqual([]);
  });

  it('auto-promotes armed -> traveling on the next tick when nothing aborts', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');

    const armed = tick(fixture);
    expect(armed.status).toBe('armed');

    const traveling = tick(fixture);
    expect(traveling.status).toBe('traveling');
    // No new decision pushed for the silent armed->traveling promotion.
    expect(decisionKinds(traveling)).toEqual(['trigger']);
  });

  it('configureSettlementReturnRouting(world, false) resets a non-idle router to idle instead of freezing its status', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');
    const armed = tick(fixture); // idle -> armed
    expect(armed.status).toBe('armed');

    // Disabling mid-cycle must fully reset to idle, not just flip the
    // internal `enabled` flag onto whatever status the router was frozen
    // in -- `SettlementReturnIntent` never exposes `enabled`, so a stale
    // non-idle status here would otherwise keep matching callers' status
    // guards (e.g. `findFloor2ProgressObjective`) forever even though the
    // router is supposed to be fully off.
    configureSettlementReturnRouting(fixture.world, false);
    const disabled = getSettlementReturnIntent(fixture.world);
    expect(disabled.status).toBe('idle');
    expect(disabled.decisions).toEqual([]);
    expect(disabled.armedAtFrame).toBeNull();

    // And it stays idle (never re-arms) while routing remains disabled,
    // even though the opportunity/position still trigger-worthy.
    for (let i = 0; i < 3; i += 1) {
      const intent = tick(fixture);
      expect(intent.status).toBe('idle');
    }
  });

  it('hysteresis: does not abandon while traveling when utility drops only into the band (not below abandonThreshold)', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');
    tick(fixture); // idle -> armed
    tick(fixture); // armed -> traveling

    fixture.moveToTile(12, 12); // mid position: utility ~11.7, above abandonThreshold=5
    const intent = tick(fixture);
    expect(intent.status).toBe('traveling');
    expect(decisionKinds(intent)).toEqual(['trigger']);
  });

  it('defers (traveling -> cooldown) when utility drops below the abandon threshold, with the defer cooldown window', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');
    tick(fixture); // idle -> armed
    tick(fixture); // armed -> traveling

    fixture.moveToTile(30, 30); // far: utility strongly negative
    const deferred = tick(fixture);
    expect(deferred.status).toBe('cooldown');
    expect(decisionKinds(deferred)).toEqual(['trigger', 'defer']);
    const expectedCooldownUntil =
      fixture.world.frameCount + SETTLEMENT_RETURN_DEFER_COOLDOWN_FRAMES;
    expect(deferred.cooldownUntilFrame).toBe(expectedCooldownUntil);

    // Still in cooldown one frame before the window closes.
    const stillCooldown = tick(fixture, {
      frameDelta: SETTLEMENT_RETURN_DEFER_COOLDOWN_FRAMES - 1,
    });
    expect(stillCooldown.status).toBe('cooldown');

    // Cooldown clears exactly at cooldownUntilFrame.
    const backToIdle = tick(fixture, { frameDelta: 1 });
    expect(backToIdle.status).toBe('idle');
    expect(decisionKinds(backToIdle)).toEqual(['trigger', 'defer']); // no new decision for the cooldown->idle step
  });

  it('aborts armed/traveling to aborted-danger then cooldown (danger cooldown window) when danger appears', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');
    tick(fixture); // idle -> armed

    const aborted = tick(fixture, { dangerNearby: true });
    expect(aborted.status).toBe('aborted-danger');
    expect(decisionKinds(aborted)).toEqual(['trigger', 'abort-danger']);

    const cooldownFrameAtTransition = fixture.world.frameCount;
    const cooling = tick(fixture); // separate tick required to commit the cooldown window
    expect(cooling.status).toBe('cooldown');
    expect(cooling.cooldownUntilFrame).toBe(
      cooldownFrameAtTransition + 1 + SETTLEMENT_RETURN_DANGER_COOLDOWN_FRAMES,
    );

    const backToIdle = tick(fixture, {
      frameDelta: SETTLEMENT_RETURN_DANGER_COOLDOWN_FRAMES,
    });
    expect(backToIdle.status).toBe('idle');
  });

  it('aborts armed/traveling to aborted-unreachable then cooldown when progressSuppressed', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');
    tick(fixture); // idle -> armed

    const aborted = tick(fixture, { progressSuppressed: true });
    expect(aborted.status).toBe('aborted-unreachable');
    expect(decisionKinds(aborted)).toEqual(['trigger', 'abort-unreachable']);

    const cooldownFrameAtTransition = fixture.world.frameCount;
    const cooling = tick(fixture);
    expect(cooling.status).toBe('cooldown');
    expect(cooling.cooldownUntilFrame).toBe(
      cooldownFrameAtTransition + 1 + SETTLEMENT_RETURN_UNREACHABLE_COOLDOWN_FRAMES,
    );
  });

  it('aborts armed/traveling to aborted-unreachable when the settlement anchor is lost (null)', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');
    tick(fixture); // idle -> armed

    fixture.world.frameCount += 1;
    const playerX = fixture.world.stores.position.x[fixture.playerEid] ?? 0;
    const playerY = fixture.world.stores.position.y[fixture.playerEid] ?? 0;
    const aborted = updateSettlementReturnIntent(
      fixture.world,
      fixture.playerEid,
      playerX,
      playerY,
      null, // anchor lost
      false,
      false,
    );
    expect(aborted.status).toBe('aborted-unreachable');
  });

  it('completes a full successful arrival cycle through the real planner: armed -> traveling -> arrived -> resuming -> cooldown -> idle', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    fixture.moveToTile(5, 5);
    unlockAchievement(fixture.world, 'first-bonk');
    expect(isAchievementClaimed(fixture.world, 'first-bonk')).toBe(false);

    tick(fixture); // idle -> armed
    tick(fixture); // armed -> traveling

    // Actually walk to the settlement and let the REAL planner run — no
    // stubs/mocks: this is the "no cheating" requirement for the arrival path.
    fixture.moveToAnchor();
    const plannerResult = runSettlementMaintenancePlanner(fixture.world);
    expect(plannerResult.ran).toBe(true);
    expect(isAchievementClaimed(fixture.world, 'first-bonk')).toBe(true);

    const arrived = tick(fixture);
    expect(arrived.status).toBe('arrived');

    const resuming = tick(fixture);
    expect(resuming.status).toBe('resuming');

    const cooldown = tick(fixture);
    expect(cooldown.status).toBe('cooldown');
    expect(cooldown.cooldownUntilFrame).toBe(
      fixture.world.frameCount + SETTLEMENT_RETURN_SERVICE_COOLDOWN_FRAMES,
    );
    // No more unclaimed opportunities post-visit.
    expect(cooldown.lastServicedFingerprint).toBe('');

    const idle = tick(fixture, { frameDelta: SETTLEMENT_RETURN_SERVICE_COOLDOWN_FRAMES });
    expect(idle.status).toBe('idle');

    expect(decisionKinds(idle)).toEqual(['trigger', 'arrive', 'maintenance', 'resume']);
  });

  it('is a deterministic replay: two fresh identical worlds/scripts produce identical final intents', () => {
    function runScenario(): SettlementReturnIntent {
      const fixture = createRouterWorld();
      configureSettlementReturnRouting(fixture.world, true);
      fixture.moveToTile(5, 5);
      unlockAchievement(fixture.world, 'first-bonk');
      tick(fixture);
      tick(fixture);
      fixture.moveToAnchor();
      runSettlementMaintenancePlanner(fixture.world);
      tick(fixture);
      tick(fixture);
      return tick(fixture);
    }
    const first = runScenario();
    const second = runScenario();
    expect(second).toEqual(first);
  });

  it('caps the decision log at SETTLEMENT_RETURN_DECISION_LOG_CAP, evicting the oldest entries', () => {
    const fixture = createRouterWorld();
    configureSettlementReturnRouting(fixture.world, true);
    unlockAchievement(fixture.world, 'first-bonk');

    // Each cycle produces 2 decisions (trigger, defer). Run enough cycles to
    // exceed the cap (32) several times over.
    let intent: SettlementReturnIntent = getSettlementReturnIntent(fixture.world);
    for (let cycle = 0; cycle < 20; cycle += 1) {
      fixture.moveToTile(5, 5); // near: triggers
      intent = tick(fixture); // idle -> armed
      expect(intent.status).toBe('armed');
      fixture.moveToTile(30, 30); // far: utility collapses below abandonThreshold
      intent = tick(fixture); // armed -> cooldown (defer)
      expect(intent.status).toBe('cooldown');
      intent = tick(fixture, { frameDelta: SETTLEMENT_RETURN_DEFER_COOLDOWN_FRAMES });
      expect(intent.status).toBe('idle'); // cooldown -> idle, ready for next cycle
    }

    expect(intent.decisions.length).toBe(SETTLEMENT_RETURN_DECISION_LOG_CAP);
    // Only the most recent cap-worth of decisions survive; the very first
    // cycle's decisions must have been evicted.
    const frames = intent.decisions.map((d) => d.frame);
    expect(new Set(frames).size).toBe(frames.length); // frames strictly distinct/ordered
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
  });

  it('getSettlementReturnIntent returns a disabled idle intent for a world that was never configured', () => {
    const fixture = createRouterWorld();
    const intent = getSettlementReturnIntent(fixture.world);
    expect(intent.status).toBe('idle');
    expect(intent.decisions).toEqual([]);
    expect(intent.lastUtility).toBeNull();
  });
});
