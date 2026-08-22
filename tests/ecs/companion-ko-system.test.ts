import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Companion,
  PartySlot,
  Team,
  companionKOSystem,
  isPartyWiped,
  spawnBehaviorEnemy,
  spawnPlayer,
  spawnRallyPoint,
} from '../../src/core/index.js';
import { TeamId } from '../../src/shared/constants.js';
import { AI_TYPE } from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

function spawnCompanion(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
  teamId: number,
  hp = 100,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, hp, AI_TYPE.CHASE, 0.1, 999, 0);
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
  addComponent(world.ecs, eid, set(PartySlot, { slot: 0, locked: 0 }));
  return eid;
}

describe('companionKOSystem', () => {
  it('knocks out instead of killing a Companion whose health reaches 0', () => {
    const world = createTestWorld();
    const companion = spawnCompanion(world, 0, 0, TeamId.PLAYER);
    world.stores.health.current[companion] = 0;

    companionKOSystem(world);

    expect(world.stores.companion.knockedOut[companion]).toBe(1);
    expect(world.stores.health.current[companion]).toBe(1);
  });

  it('leaves an already-healthy Companion alone', () => {
    const world = createTestWorld();
    const companion = spawnCompanion(world, 0, 0, TeamId.PLAYER);

    companionKOSystem(world);

    expect(world.stores.companion.knockedOut[companion]).toBe(0);
    expect(world.stores.health.current[companion]).toBe(100);
  });

  it('does not revive a knocked-out Companion while a rival is within engagement range', () => {
    const world = createTestWorld();
    const companion = spawnCompanion(world, 0, 0, TeamId.PLAYER);
    world.stores.health.current[companion] = 0;
    spawnCompanion(world, 2, 0, TeamId.ENEMY);

    for (let i = 0; i < 400; i++) {
      world.frameCount = i;
      companionKOSystem(world);
    }

    expect(world.stores.companion.knockedOut[companion]).toBe(1);
  });

  it('revives a knocked-out Companion once its team is unengaged for the recovery window', () => {
    const world = createTestWorld();
    const companion = spawnCompanion(world, 0, 0, TeamId.PLAYER);
    world.stores.health.current[companion] = 0;
    // Rival is far outside engagementRangeFt, so the team is never "engaged".
    spawnCompanion(world, 500, 500, TeamId.ENEMY);

    for (let i = 0; i < 200; i++) {
      world.frameCount = i;
      companionKOSystem(world);
    }

    expect(world.stores.companion.knockedOut[companion]).toBe(0);
    expect(world.stores.health.current[companion]).toBe(100);
  });

  it('re-arms the idle timer if the team re-engages before recovering', () => {
    const world = createTestWorld();
    const companion = spawnCompanion(world, 0, 0, TeamId.PLAYER);
    world.stores.health.current[companion] = 0;
    const rival = spawnCompanion(world, 500, 500, TeamId.ENEMY);

    // Idle for most of the window...
    for (let i = 0; i < 150; i++) {
      world.frameCount = i;
      companionKOSystem(world);
    }
    expect(world.stores.companion.knockedOut[companion]).toBe(1);

    // ...then the rival closes in and re-engages, resetting the idle clock.
    world.stores.position.x[rival] = 2;
    world.stores.position.y[rival] = 0;
    world.frameCount = 150;
    companionKOSystem(world);
    expect(world.stores.companion.knockedOut[companion]).toBe(1);

    // Even after the rival leaves again, it takes a full fresh window to recover.
    world.stores.position.x[rival] = 500;
    for (let i = 151; i < 200; i++) {
      world.frameCount = i;
      companionKOSystem(world);
    }
    expect(world.stores.companion.knockedOut[companion]).toBe(1);
  });

  it('instantly revives the whole party when the player reaches a Rally Point', () => {
    const world = createTestWorld();
    const playerEid = spawnPlayer(world, 0, 0);
    const companionA = spawnCompanion(world, 1, 0, TeamId.PLAYER);
    const companionB = spawnCompanion(world, 1, 1, TeamId.PLAYER);
    world.stores.health.current[companionA] = 0;
    world.stores.health.current[companionB] = 0;
    companionKOSystem(world); // latch the KO flags first
    spawnRallyPoint(world, 0, 0);
    world.stores.position.x[playerEid] = 0;
    world.stores.position.y[playerEid] = 0;

    companionKOSystem(world);

    expect(world.stores.companion.knockedOut[companionA]).toBe(0);
    expect(world.stores.health.current[companionA]).toBe(100);
    expect(world.stores.companion.knockedOut[companionB]).toBe(0);
    expect(world.stores.health.current[companionB]).toBe(100);
  });

  it('does not revive the party when the player is outside Rally Point range', () => {
    const world = createTestWorld();
    const playerEid = spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 1, 0, TeamId.PLAYER);
    world.stores.health.current[companion] = 0;
    companionKOSystem(world);
    spawnRallyPoint(world, 100, 100);
    world.stores.position.x[playerEid] = 0;
    world.stores.position.y[playerEid] = 0;

    companionKOSystem(world);

    expect(world.stores.companion.knockedOut[companion]).toBe(1);
  });
});

describe('isPartyWiped', () => {
  it('is false when the party has no Companions', () => {
    const world = createTestWorld();
    expect(isPartyWiped(world)).toBe(false);
  });

  it('is false when at least one party Companion is still standing', () => {
    const world = createTestWorld();
    const a = spawnCompanion(world, 0, 0, TeamId.PLAYER);
    spawnCompanion(world, 1, 0, TeamId.PLAYER);
    world.stores.companion.knockedOut[a] = 1;

    expect(isPartyWiped(world)).toBe(false);
  });

  it('is true when every party Companion is knocked out simultaneously', () => {
    const world = createTestWorld();
    const a = spawnCompanion(world, 0, 0, TeamId.PLAYER);
    const b = spawnCompanion(world, 1, 0, TeamId.PLAYER);
    world.stores.companion.knockedOut[a] = 1;
    world.stores.companion.knockedOut[b] = 1;

    expect(isPartyWiped(world)).toBe(true);
  });

  it('ignores knocked-out Companions on other teams', () => {
    const world = createTestWorld();
    const rival = spawnCompanion(world, 0, 0, TeamId.ENEMY);
    world.stores.companion.knockedOut[rival] = 1;

    expect(isPartyWiped(world)).toBe(false);
  });

  it('ignores a knocked-out Companion on the party team that has no PartySlot (non-roster ally)', () => {
    const world = createTestWorld();
    // A hypothetical non-roster ally (e.g. a future temporary summon) shares
    // the player's team id but never went through recruitPartyCompanion, so
    // it never got a PartySlot — it must not be able to trip a false wipe.
    const eid = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    addComponent(world.ecs, eid, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      eid,
      set(Companion, {
        speciesToken: 1,
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 1,
      }),
    );

    expect(isPartyWiped(world)).toBe(false);
  });
});
