import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Companion,
  Team,
  movementSystem,
  spawnBehaviorEnemy,
  spawnPlayer,
} from '../../src/core/index.js';
import { TeamId, type TeamIdValue } from '../../src/shared/constants.js';
import {
  AI_TYPE,
  companionAISystem,
  enemyAISystem,
  getCompanionAIDecision,
} from '../../src/game/index.js';
import tuning from '../../src/shared/data/tuning.json';
import { createTestWorld } from '../helpers/world-factory.js';

const ENGAGEMENT_END_FRAMES = tuning.floor3Companion.engagementEndFrames;

function spawnCompanion(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
  teamId: TeamIdValue = TeamId.PLAYER,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, 0.1, 999, 0);
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(
    world.ecs,
    eid,
    set(Companion, {
      speciesToken: 1,
      form: 0,
      level: 1,
      xp: 0,
      ownerTeam: teamId,
      knockedOut: 0,
    }),
  );
  return eid;
}

function spawnRival(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
  teamId = TeamId.ENEMY,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, 0.1, 999, 0);
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  return eid;
}

describe('companionAISystem', () => {
  it('targets the nearest rival with a different team id', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 0, 0);
    const nearRival = spawnRival(world, 4, 0);
    spawnRival(world, 8, 0);

    companionAISystem(world);
    const decision = getCompanionAIDecision(world, companion);
    expect(decision?.kind).toBe('rival-primary');
    expect(decision?.targetEid).toBe(nearRival);
  });

  it('follows player when no rival exists and companion is outside leash', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 20, 0);

    companionAISystem(world);
    const decision = getCompanionAIDecision(world, companion);
    expect(decision?.kind).toBe('follow');
    expect(decision?.targetEid).toBeDefined();
    expect(decision?.x).toBe(0);
    expect(decision?.y).toBe(0);
  });

  it('idles when inside leash and no rival exists', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 1, 0);

    companionAISystem(world);
    const decision = getCompanionAIDecision(world, companion);
    expect(decision?.kind).toBe('idle');
  });

  it('disables knocked-out companions in the real prepass to movement pipeline', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, -20);
    const companion = spawnCompanion(world, 0, 0);
    world.stores.companion.knockedOut[companion] = 1;
    world.stores.velocity.y[companion] = 1;

    companionAISystem(world);
    enemyAISystem(world);
    movementSystem(world);

    expect(getCompanionAIDecision(world, companion)?.kind).toBe('disabled');
    expect(world.stores.velocity.y[companion]).toBe(0);
    expect(world.stores.position.y[companion]).toBe(0);
  });

  it('is consumed by enemyAISystem in real prepass → ai → movement pipeline', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, -20);
    const companion = spawnCompanion(world, 0, 0);
    const rival = spawnRival(world, 0, 12);

    companionAISystem(world);
    enemyAISystem(world);
    movementSystem(world);

    const decision = getCompanionAIDecision(world, companion);
    expect(decision?.kind).toBe('rival-primary');
    expect(decision?.targetEid).toBe(rival);
    expect(world.stores.position.y[companion]).toBeGreaterThan(0);
  });

  // #4206 — "Companions need to stay near the player! Right now they wander
  // away." Root cause: chaining self-anchored engagements (each individually
  // bounded to `rivalRangeSq` of the companion's OWN position, which is
  // correct and must stay untouched — see the death/timeout regressions
  // documented in the fix's code comments) can still drag a companion
  // arbitrarily far from the player over many consecutive fights, because a
  // stale target-lock never re-evaluates on its own. The fix tracks how long
  // a player-party companion has been continuously beyond that same
  // engagement radius from the PLAYER and, once that exceeds the existing
  // `tuning.floor3Companion.engagementEndFrames` grace window (already used
  // elsewhere for Floor 3 companion recovery pacing), drops exactly one
  // stale lock so the companion re-evaluates — it never disables fresh
  // acquisition, which stays fully self-anchored and combat-capable at all
  // times, matching clean-main.
  describe('sustained-drift stale-lock recall (regression, #4206)', () => {
    it('keeps fresh acquisition fully self-anchored, matching clean-main, even far from the player', () => {
      const world = createTestWorld();
      spawnPlayer(world, 1_000, 0);
      const companion = spawnCompanion(world, 0, 0);
      const rival = spawnRival(world, 4, 0);

      companionAISystem(world);
      const decision = getCompanionAIDecision(world, companion);
      expect(decision?.kind).toBe('rival-primary');
      expect(decision?.targetEid).toBe(rival);
    });

    it('does not drop a stale lock before the sustained-drift grace window elapses', () => {
      const world = createTestWorld();
      spawnPlayer(world, 0, 0);
      const companion = spawnCompanion(world, 10, 0);
      const rival = spawnRival(world, 14, 0);

      // First tick: both well within engagement range of the player — locks.
      companionAISystem(world);
      expect(getCompanionAIDecision(world, companion)?.targetEid).toBe(rival);

      // Drag the pair far from the player, but for fewer consecutive frames
      // than the grace window — the stale lock must still hold so ordinary,
      // bounded combat excursions are never interrupted.
      world.stores.position.x[companion] = 100;
      world.stores.position.x[rival] = 104;
      for (let i = 0; i < ENGAGEMENT_END_FRAMES - 1; i += 1) {
        companionAISystem(world);
      }
      const decision = getCompanionAIDecision(world, companion);
      expect(decision?.kind).toBe('rival-primary');
      expect(decision?.targetEid).toBe(rival);
    });

    it('drops a stale lock once sustained drift exceeds the grace window, and recovers to follow once nothing is left to fight', () => {
      const world = createTestWorld();
      spawnPlayer(world, 0, 0);
      const companion = spawnCompanion(world, 10, 0);
      const rival = spawnRival(world, 14, 0);

      companionAISystem(world);
      expect(getCompanionAIDecision(world, companion)?.targetEid).toBe(rival);

      // Drag the pair far from the player and hold that for exactly the
      // grace window. The rival stays close to the companion throughout
      // (would keep a self-anchored lock forever, pre-fix) but is not close
      // enough to the PLAYER — the lock must still hold up to (and
      // including) the grace window itself, since fresh acquisition below
      // would otherwise just re-find the same nearby rival and mask whether
      // the recall logic engaged at all.
      world.stores.position.x[companion] = 100;
      world.stores.position.x[rival] = 104;
      for (let i = 0; i < ENGAGEMENT_END_FRAMES; i += 1) {
        companionAISystem(world);
      }
      expect(getCompanionAIDecision(world, companion)?.targetEid).toBe(rival);

      // The rival independently leaves the companion's own self-anchored
      // engagement range (e.g. it died or fled far away on its own) right as
      // sustained drift crosses the grace window on this next tick — with
      // nothing left nearby to reacquire, the sustained-drift recall must
      // now surface as the leash-bounded follow decision.
      world.stores.position.x[rival] = 10_000;
      companionAISystem(world);
      const decision = getCompanionAIDecision(world, companion);
      expect(decision?.kind).toBe('follow');
      expect(decision?.targetEid).toBeDefined();
      expect(decision?.x).toBe(0);
      expect(decision?.y).toBe(0);
    });

    it('resets the sustained-drift counter once back in range, so a later dip never carries over', () => {
      const world = createTestWorld();
      spawnPlayer(world, 0, 0);
      const companion = spawnCompanion(world, 10, 0);
      const rival = spawnRival(world, 14, 0);

      companionAISystem(world);
      expect(getCompanionAIDecision(world, companion)?.targetEid).toBe(rival);

      // Drift far for most of the grace window...
      world.stores.position.x[companion] = 100;
      world.stores.position.x[rival] = 104;
      for (let i = 0; i < ENGAGEMENT_END_FRAMES - 1; i += 1) {
        companionAISystem(world);
      }

      // ...then return within range for a single frame, which must reset
      // the counter back to zero...
      world.stores.position.x[companion] = 10;
      world.stores.position.x[rival] = 14;
      companionAISystem(world);
      expect(getCompanionAIDecision(world, companion)?.kind).toBe('rival-primary');

      // ...so drifting far again for almost-but-not-quite the full window
      // must still hold the lock instead of dropping it early from leftover
      // count.
      world.stores.position.x[companion] = 100;
      world.stores.position.x[rival] = 104;
      for (let i = 0; i < ENGAGEMENT_END_FRAMES - 1; i += 1) {
        companionAISystem(world);
      }
      const decision = getCompanionAIDecision(world, companion);
      expect(decision?.kind).toBe('rival-primary');
      expect(decision?.targetEid).toBe(rival);
    });

    it('keeps an NPC-owned roster self-anchored indefinitely so scripted versus encounters are unaffected', () => {
      const world = createTestWorld();
      // Player standing far away from where this NPC-vs-NPC skirmish plays
      // out — #4206 is specifically "my companion wanders from ME", not a
      // license to re-tune unrelated Studio/Final-Four versus encounters
      // that have no owning player to anchor on.
      spawnPlayer(world, 1_000, 1_000);
      const npcCompanion = spawnCompanion(world, 100, 0, TeamId.NEUTRAL);
      const npcRival = spawnRival(world, 104, 0, TeamId.ENEMY);

      companionAISystem(world);
      expect(getCompanionAIDecision(world, npcCompanion)?.targetEid).toBe(npcRival);

      // Hold well past the grace window that WOULD apply to a player-owned
      // companion — an NPC-owned roster must never accumulate a drift
      // streak at all, so the lock must still hold.
      for (let i = 0; i < ENGAGEMENT_END_FRAMES + 1; i += 1) {
        companionAISystem(world);
      }
      const decision = getCompanionAIDecision(world, npcCompanion);
      expect(decision?.kind).toBe('rival-primary');
      expect(decision?.targetEid).toBe(npcRival);
    });
  });
});
