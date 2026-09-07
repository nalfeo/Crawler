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
  aiType: number = AI_TYPE.CHASE,
  attackRange = 0,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, aiType, 0.1, 999, attackRange);
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

  it('ramps Floor 3 player-owned follow speed with distance while the player is stationary', () => {
    const world = createTestWorld();
    world.floorId = 'floor3';
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 12, 0);

    companionAISystem(world);
    enemyAISystem(world);
    const nearSpeed = Math.hypot(
      world.stores.velocity.x[companion] ?? 0,
      world.stores.velocity.y[companion] ?? 0,
    );

    world.stores.position.x[companion] = 24;
    companionAISystem(world);
    enemyAISystem(world);
    const farSpeed = Math.hypot(
      world.stores.velocity.x[companion] ?? 0,
      world.stores.velocity.y[companion] ?? 0,
    );

    expect(farSpeed).toBeGreaterThan(nearSpeed);

    // Stationary player (spawnPlayer's default zero velocity): the cap
    // collapses to `base * followSpeedMaxMultiplier` because the
    // `playerSpeed * followSpeedMaxMultiplier` term is also zero, so this
    // exercises the authored-speed side of the cap, not
    // `followSpeedPlayerMultiplier`. Stay within the companion's 999ft
    // aggroRange (see `spawnCompanion`) so the legacy-chase aggro gate never
    // masks the ramp/cap math under test.
    world.stores.position.x[companion] = 500;
    companionAISystem(world);
    enemyAISystem(world);
    const cappedSpeed = Math.hypot(
      world.stores.velocity.x[companion] ?? 0,
      world.stores.velocity.y[companion] ?? 0,
    );
    const expectedCap = 0.1 * tuning.floor3Companion.followSpeedMaxMultiplier;
    expect(cappedSpeed).toBeCloseTo(expectedCap, 5);
  });

  it('ramps the follow-speed baseline and cap off a moving player via followSpeedPlayerMultiplier', () => {
    const world = createTestWorld();
    world.floorId = 'floor3';
    const playerEid = spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 12, 0);
    world.stores.velocity.x[playerEid] = 1;
    world.stores.velocity.y[playerEid] = 0;

    const base = 0.1;
    const playerSpeed = 1;
    const leash = tuning.factionRelations.friendlyLeashTiles;
    const baseline = Math.max(
      base,
      playerSpeed * tuning.floor3Companion.followSpeedPlayerMultiplier,
    );
    const cap = Math.max(
      baseline,
      base * tuning.floor3Companion.followSpeedMaxMultiplier,
      playerSpeed * tuning.floor3Companion.followSpeedMaxMultiplier,
    );

    // At 12ft (6ft beyond the leash), the `playerSpeed * followSpeedPlayerMultiplier`
    // term (1.25) dominates the authored companion speed (0.1), and the
    // per-foot ramp has already added a further 0.06 on top of that baseline.
    companionAISystem(world);
    enemyAISystem(world);
    const nearSpeed = Math.hypot(
      world.stores.velocity.x[companion] ?? 0,
      world.stores.velocity.y[companion] ?? 0,
    );
    const expectedNearSpeed = Math.min(
      cap,
      baseline + Math.max(0, 12 - leash) * tuning.floor3Companion.followSpeedRampPerFt,
    );
    expect(nearSpeed).toBeCloseTo(expectedNearSpeed, 5);

    // Cap: far enough (but still within the companion's 999ft aggroRange —
    // see `spawnCompanion`) that the per-foot ramp exceeds the cap, which is
    // now driven by `playerSpeed * followSpeedMaxMultiplier` (2.5), the
    // largest of the three cap terms.
    world.stores.position.x[companion] = 500;
    companionAISystem(world);
    enemyAISystem(world);
    const cappedSpeed = Math.hypot(
      world.stores.velocity.x[companion] ?? 0,
      world.stores.velocity.y[companion] ?? 0,
    );
    expect(cappedSpeed).toBeCloseTo(cap, 5);
  });

  it('returns an out-of-leash Floor 3 companion to the leash within 180 frames', () => {
    const world = createTestWorld();
    world.floorId = 'floor3';
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 24, 0);

    for (let frame = 0; frame < 180; frame += 1) {
      companionAISystem(world);
      enemyAISystem(world);
      movementSystem(world);
      world.frameCount += 1;
    }

    expect(
      Math.hypot(world.stores.position.x[companion] ?? 0, world.stores.position.y[companion] ?? 0),
    ).toBeLessThanOrEqual(tuning.factionRelations.friendlyLeashTiles);
  });

  it.each([
    ['RANGED', AI_TYPE.RANGED],
    ['SUPPORT', AI_TYPE.SUPPORT],
  ])(
    'closes distance to the player for an out-of-leash %s companion instead of holding standoff',
    (_label, aiType) => {
      const world = createTestWorld();
      world.floorId = 'floor3';
      spawnPlayer(world, 0, 0);
      // Real Floor 3 slingers/bursters (RANGED) and kindlers (SUPPORT) are
      // stamped with a positive attackRange (see floor3Scenario.ts), which is
      // exactly what makes their authored movement kite/hold standoff instead
      // of closing distance — a companion following the player must not do
      // that (#4373 follow-up review).
      const companion = spawnCompanion(world, 24, 0, TeamId.PLAYER, aiType, 8);

      companionAISystem(world);
      expect(getCompanionAIDecision(world, companion)?.kind).toBe('follow');
      enemyAISystem(world);
      movementSystem(world);

      const distanceAfterOneFrame = Math.hypot(
        world.stores.position.x[companion] ?? 0,
        world.stores.position.y[companion] ?? 0,
      );
      expect(distanceAfterOneFrame).toBeLessThan(24);
    },
  );

  it.each([
    ['RANGED', AI_TYPE.RANGED],
    ['SUPPORT', AI_TYPE.SUPPORT],
  ])(
    'still returns an out-of-leash %s companion to the leash within 180 frames',
    (_label, aiType) => {
      const world = createTestWorld();
      world.floorId = 'floor3';
      spawnPlayer(world, 0, 0);
      const companion = spawnCompanion(world, 24, 0, TeamId.PLAYER, aiType, 8);

      for (let frame = 0; frame < 180; frame += 1) {
        companionAISystem(world);
        enemyAISystem(world);
        movementSystem(world);
        world.frameCount += 1;
      }

      expect(
        Math.hypot(
          world.stores.position.x[companion] ?? 0,
          world.stores.position.y[companion] ?? 0,
        ),
      ).toBeLessThanOrEqual(tuning.factionRelations.friendlyLeashTiles);
    },
  );

  it('does not apply the follow-speed ramp to Floor 4 or NPC companions', () => {
    const world = createTestWorld();
    world.floorId = 'floor4';
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 1_000, 0);

    companionAISystem(world);
    enemyAISystem(world);
    expect(
      Math.hypot(world.stores.velocity.x[companion] ?? 0, world.stores.velocity.y[companion] ?? 0),
    ).toBeLessThanOrEqual(0.100001);

    world.floorId = 'floor3';
    const npc = spawnCompanion(world, 1_000, 10, TeamId.NEUTRAL);
    companionAISystem(world);
    enemyAISystem(world);
    expect(
      Math.hypot(world.stores.velocity.x[npc] ?? 0, world.stores.velocity.y[npc] ?? 0),
    ).toBeLessThanOrEqual(0.100001);
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
      world.floorId = 'floor3';
      spawnPlayer(world, 0, 0);
      const companion = spawnCompanion(world, 10, 0);
      const rival = spawnCompanion(world, 14, 0, TeamId.ENEMY);

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

    it('drops a stale lock once sustained drift exceeds the grace window, forcing a fresh nearest-rival scan', () => {
      const world = createTestWorld();
      world.floorId = 'floor3';
      spawnPlayer(world, 0, 0);
      const companion = spawnCompanion(world, 10, 0);
      const rivalA = spawnCompanion(world, 14, 0, TeamId.ENEMY);

      companionAISystem(world);
      expect(getCompanionAIDecision(world, companion)?.targetEid).toBe(rivalA);

      // Drag the companion+rivalA pair far from the player together, keeping
      // rivalA within the companion's own self-anchored engagement range for
      // the entire hold (dx stays 4) — the pre-existing self-anchored range
      // check alone would therefore keep this lock valid forever, with or
      // without the sustained-drift fix. Any eventual target switch here can
      // only be explained by the new recall logic, not by rivalA becoming
      // independently invalid.
      world.stores.position.x[companion] = 100;
      world.stores.position.x[rivalA] = 104;
      for (let i = 0; i < ENGAGEMENT_END_FRAMES; i += 1) {
        companionAISystem(world);
      }
      // Still locked through (and including) the grace window itself.
      expect(getCompanionAIDecision(world, companion)?.targetEid).toBe(rivalA);

      // Introduce a second, strictly-nearer rival exactly as the streak
      // crosses the grace window on this next tick. A locked target is never
      // displaced by a merely-nearer candidate (see the target-lock comment
      // above) — so rivalB can only be picked up if the sustained-drift
      // recall actually forces a fresh nearest-rival scan this frame. If the
      // recall regresses to a no-op, the stale lock on rivalA would simply
      // continue (rivalA is still self-anchored-valid) and rivalB would
      // never be selected.
      const rivalB = spawnCompanion(world, 101, 0, TeamId.ENEMY);
      companionAISystem(world);
      const decision = getCompanionAIDecision(world, companion);
      expect(decision?.kind).toBe('rival-primary');
      expect(decision?.targetEid).toBe(rivalB);
    });

    it('does not apply the sustained-drift recall outside Floor 3, keeping other floors byte-identical to clean-main', () => {
      const world = createTestWorld();
      world.floorId = 'floor4';
      spawnPlayer(world, 0, 0);
      const companion = spawnCompanion(world, 10, 0);
      const rivalA = spawnCompanion(world, 14, 0, TeamId.ENEMY);

      companionAISystem(world);
      expect(getCompanionAIDecision(world, companion)?.targetEid).toBe(rivalA);

      // Drag the pair far from the player and hold well past the grace
      // window that would trigger a recall on Floor 3. #4206 was reported
      // and validated exclusively for Floor 3; Floor 4's kept co-star (also
      // `TeamId.PLAYER`) must keep its pre-existing stale-lock behavior
      // unchanged, so the lock must never break here.
      world.stores.position.x[companion] = 100;
      world.stores.position.x[rivalA] = 104;
      for (let i = 0; i < ENGAGEMENT_END_FRAMES + 5; i += 1) {
        companionAISystem(world);
      }
      const decision = getCompanionAIDecision(world, companion);
      expect(decision?.kind).toBe('rival-primary');
      expect(decision?.targetEid).toBe(rivalA);
    });

    it('resets the sustained-drift counter once back in range, so a later dip never carries over', () => {
      const world = createTestWorld();
      world.floorId = 'floor3';
      spawnPlayer(world, 0, 0);
      const companion = spawnCompanion(world, 10, 0);
      const rival = spawnCompanion(world, 14, 0, TeamId.ENEMY);

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
