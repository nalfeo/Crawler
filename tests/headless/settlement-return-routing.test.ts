import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { spawnEnemy } from '../../src/core/helpers.js';
import { unlockAchievement } from '../../src/game/systems/achievementSystem.js';
import {
  getSettlementReturnIntent,
  type SettlementReturnStatus,
} from '../../src/game/ai/settlement-return-router.js';
import { getLastSettlementMaintenanceResult } from '../../src/game/ai/settlement-maintenance-planner.js';
import {
  FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID,
  FLOOR2_SETTLEMENT_FOUND_GOAL_ID,
} from '../../src/game/floor2Scenario.js';
import type { SimEvent } from '../../src/game/ai/event-log.js';
import type { GameWorld } from '../../src/core/world.js';

/**
 * Floor 1 lootBox-reward achievements (see `src/shared/data/achievements.floor1.json`),
 * unlocked in bulk to guarantee positive settlement-return utility regardless
 * of the exact travel distance a given seed's generated map produces: 6 *
 * `achievementGain` (40) = 240 expected gain comfortably clears both the
 * `triggerThreshold` (20) and any plausible travel cost
 * (`travelCostPerFoot` 0.5 * the ~278ft max diagonal of the 240x140 map =
 * ~139) on `DEFAULT_SETTLEMENT_RETURN_UTILITY_PARAMS`.
 */
const OPPORTUNITY_ACHIEVEMENT_IDS = [
  'first-bonk',
  'slime-no-more',
  'rat-retired',
  'triple-swipe',
  'five-chain',
  'ten-chain',
];

const PLAYER_EID = 1;

/**
 * Forces the mandatory first-visit "settlement found"/"broker intro" goals
 * complete and seeds unclaimed-achievement opportunity, so any subsequent
 * trip to the settlement is driven by the settlement-RETURN router (this
 * feature) rather than the pre-existing mandatory first-visit Progress
 * branch that already exists independent of this feature.
 */
function armEligibleOpportunity(world: GameWorld): void {
  world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
  world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);
  for (const id of OPPORTUNITY_ACHIEVEMENT_IDS) {
    unlockAchievement(world, id);
  }
}

interface SettlementReturnTelemetryEntry {
  readonly frame: number;
  readonly status: string;
}

/**
 * Extracts the ordered settlement-return telemetry entries from a recorded
 * event stream. `headless-runner.ts` emits one `'control'`-typed `SimEvent`
 * per settlement-return STATUS CHANGE (not every frame), with the status
 * encoded as the `note` field: `` `settlement-return: ${status}` ``,
 * optionally suffixed with `` ` — ${decisionDetail}` ``.
 */
function settlementReturnTelemetry(events: readonly SimEvent[]): SettlementReturnTelemetryEntry[] {
  const prefix = 'settlement-return: ';
  const entries: SettlementReturnTelemetryEntry[] = [];
  for (const event of events) {
    if (
      event.type === 'control' &&
      typeof event.note === 'string' &&
      event.note.startsWith(prefix)
    ) {
      const status = event.note.slice(prefix.length).split(' — ')[0] ?? '';
      entries.push({ frame: event.frame, status });
    }
  }
  return entries;
}

/**
 * True if `needle` appears as an in-order (not necessarily contiguous)
 * subsequence of `haystack`. Used to assert a state-machine visited a
 * required sequence of statuses without being brittle to harmless extra
 * transitions before/after/between the ones under test (e.g. a `cooldown` ->
 * `idle` cycle repeating after the assertion's window of interest).
 */
function containsOrderedSubsequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  return findOrderedSubsequenceIndexes(haystack, needle).length === needle.length;
}

function findOrderedSubsequenceIndexes(
  haystack: readonly string[],
  needle: readonly string[],
): number[] {
  let cursor = 0;
  const indexes: number[] = [];
  for (const [index, item] of haystack.entries()) {
    if (cursor < needle.length && item === needle[cursor]) {
      indexes.push(index);
      cursor += 1;
    }
  }
  return indexes;
}

describe('settlement return routing (headless integration)', () => {
  it('triggers on positive utility, travels via real pathing, runs maintenance on arrival, resumes hunting, and returns to combat within a bounded frame window', async () => {
    const seed = 2;
    const events: SimEvent[] = [];
    let seeded = false;

    const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
      seed,
      floorId: 'floor2',
      maxFrames: 8000,
      questStallFrames: 0,
      settlementReturnRouting: true,
      enforcePlayabilityInvariants: false,
      recordEvent: (event) => events.push(event),
      simulationOptions: {
        postSystems: [
          (world) => {
            // Wait for the mandatory first-visit Progress branch to reach
            // the settlement before seeding opportunity. Seeding immediately
            // at frame 1 instead forces the return trip to start from the
            // player's far-away spawn point, which on this floor2 map
            // may never complete a clean cycle within the frame budget --
            // every attempt can be intercepted by organic combat en route.
            // Seeding right after the mandatory visit starts the return trip
            // from right next to the settlement (a short, low-risk trip),
            // which is the realistic case this "happy path" test is
            // meant to cover -- the danger/unreachable interruption
            // paths are already covered in isolation by the dedicated
            // tests below.
            if (!seeded && getLastSettlementMaintenanceResult(world)?.ran === true) {
              seeded = true;
              armEligibleOpportunity(world);
            }
          },
        ],
      },
    });

    const telemetry = settlementReturnTelemetry(events);
    const statuses = telemetry.map((entry) => entry.status);

    // Full deterministic cycle: idle (armed with opportunity) -> armed ->
    // traveling (real pathing) -> arrived (planner physically ran) ->
    // resuming -> cooldown (service latch recorded).
    const fullCycle = ['idle', 'armed', 'traveling', 'arrived', 'resuming', 'cooldown'];
    const fullCycleIndexes = findOrderedSubsequenceIndexes(statuses, fullCycle);
    expect(fullCycleIndexes.length).toBe(fullCycle.length);

    expect(['victory', 'timeout']).toContain(stats.outcome);

    // Bounded time-lost / bounded return to combat: the AI must not get
    // "lost" doing maintenance indefinitely. Measure the real frame gap
    // between arming and settling into cooldown (round trip + planner
    // execution) against a generous ceiling far below the run's frame
    // budget.
    const armedIndex = fullCycleIndexes[1]!;
    const cooldownIndex = fullCycleIndexes[5]!;

    const armedFrame = telemetry[armedIndex]!.frame;
    const cooldownFrame = telemetry[cooldownIndex]!.frame;
    const BOUNDED_ROUND_TRIP_FRAMES = 3000;
    expect(cooldownFrame - armedFrame).toBeLessThan(BOUNDED_ROUND_TRIP_FRAMES);
  }, 60_000);

  it('produces identical settlement-return telemetry across two runs with the same seed and config (deterministic replay)', async () => {
    async function run(): Promise<SettlementReturnTelemetryEntry[]> {
      const events: SimEvent[] = [];
      let seeded = false;
      await runHeadless(new BehaviorTreeAI({ seed: 92 }), {
        seed: 92,
        floorId: 'floor2',
        maxFrames: 4000,
        questStallFrames: 0,
        settlementReturnRouting: true,
        enforcePlayabilityInvariants: false,
        recordEvent: (event) => events.push(event),
        simulationOptions: {
          postSystems: [
            (world) => {
              if (!seeded) {
                seeded = true;
                armEligibleOpportunity(world);
              }
            },
          ],
        },
      });
      return settlementReturnTelemetry(events);
    }

    const first = await run();
    const second = await run();

    expect(first.length).toBeGreaterThan(1);
    expect(second).toEqual(first);
  }, 90_000);

  it('stays idle when opportunity is nil, even with the settlement anchor known and reachable (negative-utility no-trigger)', async () => {
    const observedStatuses = new Set<SettlementReturnStatus>();
    let flagsForced = false;

    const stats = await runHeadless(new BehaviorTreeAI({ seed: 92 }), {
      seed: 92,
      floorId: 'floor2',
      maxFrames: 800,
      questStallFrames: 0,
      settlementReturnRouting: true,
      enforcePlayabilityInvariants: false,
      simulationOptions: {
        preSystems: [
          (world) => {
            // Deny organic achievement accrual: mark every currently-unlocked
            // achievement as claimed so the router's unclaimedAchievements
            // count stays zero regardless of what achievementSystem adds this
            // frame. Clearing unlockedIds alone is insufficient because
            // achievementSystem (canonical postSystems) re-unlocks achievements
            // after preSystems runs; marking claimed suppresses the router's
            // opportunity signal in the next AI poll without defeating the
            // achievement dedup guard.
            for (const id of world.achievements.unlockedIds) {
              world.achievements.claimedIds.add(id);
            }
            world.achievements.unlockedIds.clear();
          },
        ],
        postSystems: [
          (world) => {
            // Mark any achievements freshly unlocked by achievementSystem
            // (canonical postSystems) as claimed so they don't give the
            // router a false opportunity signal on the next frame's AI poll.
            for (const id of world.achievements.unlockedIds) {
              world.achievements.claimedIds.add(id);
            }
            if (!flagsForced) {
              flagsForced = true;
              world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
              world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);
            }
            observedStatuses.add(getSettlementReturnIntent(world).status);
          },
        ],
      },
    });

    expect(observedStatuses).toEqual(new Set<SettlementReturnStatus>(['idle']));
    expect(stats.outcome).not.toBe('error');
  }, 30_000);

  it('emits zero settlement-return telemetry when the feature is left at its default-off configuration (regression guard)', async () => {
    const events: SimEvent[] = [];
    let seeded = false;

    await runHeadless(new BehaviorTreeAI({ seed: 92 }), {
      seed: 92,
      floorId: 'floor2',
      maxFrames: 1500,
      questStallFrames: 0,
      // settlementReturnRouting intentionally omitted -> defaults to false.
      recordEvent: (event) => events.push(event),
      simulationOptions: {
        postSystems: [
          (world) => {
            if (!seeded) {
              seeded = true;
              armEligibleOpportunity(world);
            }
          },
        ],
      },
    });

    expect(settlementReturnTelemetry(events)).toHaveLength(0);
  }, 30_000);

  it('aborts as unreachable when the shared progress-suppression signal fires mid-travel, then recovers via cooldown', async () => {
    const seed = 92;
    const ai = new BehaviorTreeAI({ seed });
    const events: SimEvent[] = [];
    let seeded = false;
    let poked = false;

    await runHeadless(ai, {
      seed,
      floorId: 'floor2',
      maxFrames: 4000,
      questStallFrames: 0,
      settlementReturnRouting: true,
      enforcePlayabilityInvariants: false,
      recordEvent: (event) => events.push(event),
      simulationOptions: {
        postSystems: [
          (world) => {
            if (!seeded) {
              seeded = true;
              armEligibleOpportunity(world);
            }
            const status = getSettlementReturnIntent(world).status;
            if (!poked && (status === 'armed' || status === 'traveling')) {
              poked = true;
              // Deliberately poke the same real "progress goal suppressed"
              // signal the BT layer already computes for every other
              // mandatory Progress branch (bt-ai-provider.ts's
              // `progressGoalSuppressedUntilFrame`), rather than
              // constructing a literally walled-off settlement room --
              // this mirrors settlement-return-router.ts's module doc
              // ("exactly one definition of ... unreachable shared with
              // every sibling Progress branch") and the equivalent
              // BT-integration-level scenario in behavior-tree-ai.test.ts.
              (
                ai as unknown as { progressGoalSuppressedUntilFrame: number }
              ).progressGoalSuppressedUntilFrame = world.frameCount + 100_000;
            }
          },
        ],
      },
    });

    const statuses = settlementReturnTelemetry(events).map((entry) => entry.status);
    expect(containsOrderedSubsequence(statuses, ['armed', 'aborted-unreachable', 'cooldown'])).toBe(
      true,
    );
  }, 60_000);

  it('aborts as danger when a threat appears mid-travel, then recovers via cooldown, preserving combat priority', async () => {
    const seed = 92;
    const events: SimEvent[] = [];
    let seeded = false;
    let spawned = false;

    await runHeadless(new BehaviorTreeAI({ seed }), {
      seed,
      floorId: 'floor2',
      maxFrames: 4000,
      questStallFrames: 0,
      settlementReturnRouting: true,
      enforcePlayabilityInvariants: false,
      recordEvent: (event) => events.push(event),
      simulationOptions: {
        postSystems: [
          (world) => {
            if (!seeded) {
              seeded = true;
              armEligibleOpportunity(world);
            }
            const status = getSettlementReturnIntent(world).status;
            if (!spawned && status === 'traveling') {
              spawned = true;
              const x = world.stores.position.x[PLAYER_EID] ?? 0;
              const y = world.stores.position.y[PLAYER_EID] ?? 0;
              // A bare `spawnEnemy` has Enemy+Position+Health (a real
              // threat for `findNearestEnemy`/`isEnemyCombatEligible`), but
              // no `EnemyBehavior`, so `enemyAISystem`'s
              // [Enemy, EnemyBehavior, Position, Velocity] query never
              // matches it -- it is an inert danger-signal-only entity,
              // safe to drop into the real headless pipeline. See
              // behavior-tree-ai.test.ts's BT-level settlement-return
              // danger test for the strict combat-priority identity proof;
              // this test only needs to prove the real headless pipeline
              // reacts the same way under real pathing/AI wiring.
              spawnEnemy(world, x + 5, y, 20);
            }
          },
        ],
      },
    });

    const statuses = settlementReturnTelemetry(events).map((entry) => entry.status);
    expect(containsOrderedSubsequence(statuses, ['armed', 'aborted-danger', 'cooldown'])).toBe(
      true,
    );
  }, 60_000);

  it('never claims credit for the mandatory first-visit settlement arrival while its own status stays idle (false-transition guard)', async () => {
    const observedStatuses = new Set<SettlementReturnStatus>();
    let observedMaintenanceRan = false;

    const stats = await runHeadless(new BehaviorTreeAI({ seed: 92 }), {
      seed: 92,
      floorId: 'floor2',
      maxFrames: 2500,
      questStallFrames: 0,
      settlementReturnRouting: true,
      enforcePlayabilityInvariants: false,
      simulationOptions: {
        postSystems: [
          (world) => {
            // Mark any achievements freshly unlocked by achievementSystem
            // (canonical postSystems) as claimed so they don't give the
            // router a false opportunity signal on the next frame's AI poll.
            // New Floor 2 achievements (e.g. kill-based) fire organically
            // during this run; without this guard they arm the router and
            // break the "stays idle" assertion.
            for (const id of world.achievements.unlockedIds) {
              world.achievements.claimedIds.add(id);
            }
            observedStatuses.add(getSettlementReturnIntent(world).status);
            if (getLastSettlementMaintenanceResult(world)?.ran === true) {
              observedMaintenanceRan = true;
            }
          },
        ],
      },
    });

    // The AI's normal, pre-existing mandatory Progress branch beelines to
    // the settlement anchor as its very first EXPLORE target on this seed
    // (see floor2-completion.test.ts), independent of goal flags or this
    // feature. `runSettlementMaintenancePlanner` fires unconditionally on
    // physical settlement-room arrival regardless of router status, so
    // this run genuinely exercises that mandatory-arrival path -- proving
    // the router's `idle` case correctly never reads
    // `getLastSettlementMaintenanceResult` and so never falsely reports
    // `arrived`/`resuming` for an arrival it did not itself request.
    expect(observedMaintenanceRan).toBe(true);
    expect(observedStatuses).toEqual(new Set<SettlementReturnStatus>(['idle']));
    expect(stats.outcome).not.toBe('error');
  }, 30_000);
});
