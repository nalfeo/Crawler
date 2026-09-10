import { hasComponent, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, Invincible, PartySlot, Player, Position, Team } from '../../src/core/index.js';
import { getActiveWeaponDef } from '../../src/core/active-weapon.js';
import type { GameWorld } from '../../src/core/world.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import type { SimEvent } from '../../src/game/ai/event-log.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { TeamId } from '../../src/shared/constants.js';

/**
 * Real-pipeline (`runHeadless`) evidence for the Floor 3 Trainer-poach pause
 * added in slice 12. A lab cannot prove this: the poach surface pauses the
 * world on `'loadout'` mid-run, and only the real runner loop decides whether
 * that pause is resolved or stalls the floor for the rest of the run.
 */
function countPartyCompanions(world: GameWorld): number {
  let count = 0;
  for (const eid of query(world.ecs, [Companion, Team, PartySlot])) {
    if ((world.stores.team.id[eid] ?? -1) === TeamId.PLAYER) count += 1;
  }
  return count;
}

/** Knocks out every Companion on `teamIds`, the way a real fight resolves. */
function knockOutTeams(world: GameWorld, teamIds: readonly number[]): void {
  for (const eid of query(world.ecs, [Companion, Team])) {
    if (!teamIds.includes(world.stores.team.id[eid] ?? -1)) continue;
    world.stores.companion.knockedOut[eid] = 1;
  }
}

function countCompanionsOnTeams(world: GameWorld, teamIds: readonly number[]): number {
  return query(world.ecs, [Companion, Team]).filter((eid) =>
    teamIds.includes(world.stores.team.id[eid] ?? -1),
  ).length;
}

describe('floor3 Trainer-poach loadout pause (headless pipeline)', () => {
  // The starter-Companion pick is an automatic `'loadout'` pause at floor
  // entry (spec R5 §6.1), mirroring Floor 1's weapon pick — it is not gated
  // behind interacting with Professor Thistle, whose NPC is flavor/decorative
  // (confirmed separately below: "leaves the entrance without repeatedly
  // interacting with Professor Thistle"). This test therefore starts from
  // that real auto-selected pause rather than fabricating an interaction
  // requirement the design doesn't have, and proves the rest of the loop:
  // the pet fights and actually defeats a mob while leaving the starting
  // room over a full 1,800-frame budget, and the Wrangler stays passive.
  it('uses the starter companion to fight and defeat a mob while the Wrangler remains unharmed and unarmed', async () => {
    let playerIsInvincible = false;
    let playerHasWeapon = true;
    let sawCompanionAttributedKill = false;

    const stats = await runHeadless(new BehaviorTreeAI({ seed: 4015 }), {
      seed: 4015,
      floorId: 'floor3',
      maxFrames: 1800,
      questStallFrames: 0,
      onFinish: (world) => {
        const player = query(world.ecs, [Player])[0];
        playerIsInvincible = player !== undefined && hasComponent(world.ecs, player, Invincible);
        playerHasWeapon = getActiveWeaponDef(world) !== undefined;
        // Floor 3 Companions never actually reach 0 HP — `companionKOSystem`
        // clamps `Health.current` to 1 and flips `knockedOut` instead — so a
        // real `death`/`enemy` combat event can only be a genuine trash mob,
        // and a `sourceEid` carrying `Companion` proves the starter pet (not
        // the invincible, unarmed Wrangler) landed the killing blow.
        sawCompanionAttributedKill = world.combatEvents.some(
          (event) =>
            event.type === 'death' &&
            event.targetType === 'enemy' &&
            event.sourceEid !== undefined &&
            hasComponent(world.ecs, event.sourceEid, Companion),
        );
      },
    });

    expect(stats.combat.totalKills).toBeGreaterThan(0);
    expect(sawCompanionAttributedKill).toBe(true);
    expect(stats.combat.damageDealt).toBeGreaterThan(0);
    expect(stats.combat.damageTaken).toBe(0);
    expect(playerIsInvincible).toBe(true);
    expect(playerHasWeapon).toBe(false);
  });

  it('logs the initial starter pick while resolving the real Floor 3 loadout hook', async () => {
    const events: SimEvent[] = [];
    let partyAtFinish = 0;

    await runHeadless(new BehaviorTreeAI({ seed: 33 }), {
      seed: 33,
      floorId: 'floor3',
      maxFrames: 1,
      questStallFrames: 0,
      recordEvent: (event) => events.push(event),
      onFinish: (world) => {
        partyAtFinish = countPartyCompanions(world);
      },
    });

    expect(
      events.some(
        (event) =>
          event.type === 'control' &&
          event.reason === 'loadout auto-selected through scenario.selectLoadoutOption' &&
          event.note === 'floor3 initial loadout auto-selected option 0',
      ),
    ).toBe(true);
    expect(partyAtFinish).toBe(1);
  });

  it('leaves the entrance without repeatedly interacting with Professor Thistle', async () => {
    const events: SimEvent[] = [];
    let professorEid: number | undefined;
    let leftEntrance = false;

    await runHeadless(new BehaviorTreeAI({ seed: 33 }), {
      seed: 33,
      floorId: 'floor3',
      maxFrames: 600,
      questStallFrames: 0,
      eventSampleInterval: 1,
      recordEvent: (event) => events.push(event),
      stopWhen: (world) => {
        const playerEid = query(world.ecs, [Player, Position])[0];
        const floorMap = world.floorMap;
        if (playerEid === undefined || !floorMap?.spawnRoom) return false;
        const tile = floorMap.worldToTile(
          world.stores.position.x[playerEid] ?? 0,
          world.stores.position.y[playerEid] ?? 0,
        );
        leftEntrance ||= floorMap.roomGraph.getRoomAt(tile.x, tile.y) !== floorMap.spawnRoom.id;
        return leftEntrance;
      },
      onFinish: (world) => {
        professorEid = world.floorExtendedState?.floor3CompanionProfessorNpcEid;
      },
    });

    expect(professorEid).toBeDefined();
    expect(leftEntrance).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'sample' && event.state === 'INTERACT' && event.targetEid === professorEid,
      ),
    ).toBe(false);
  });

  it('resolves the mid-run poach pause and keeps the floor simulating', async () => {
    let sawPause = false;
    let partyBeforePoach = 0;
    let partyAfterPoach = 0;
    let studioWiped = false;
    let framesAfterWipe = 0;
    let finalState: GameWorld['state'] = 'playing';
    let pendingOfferAtEnd = true;

    await runHeadless(new BehaviorTreeAI({ seed: 31 }), {
      seed: 31,
      floorId: 'floor3',
      maxFrames: 900,
      questStallFrames: 0,
      startPlayerLevel: 20,
      // `stopWhen` is the only per-frame seam the runner exposes. It is used
      // here to wipe one Studio roster once — the deterministic stand-in for
      // the player actually beating that Studio — and then to observe how the
      // real loop handles the pause the defeat produces. It never stops the
      // run early.
      stopWhen: (world) => {
        const studios = world.floorExtendedState?.floor3Studios;
        if (!studios) return false;
        if (!studioWiped) {
          const target = studios.studios.find(
            (studio) => studio.unlocked && studio.pendingSpawns.length === 0 && !studio.defeated,
          );
          if (target) {
            partyBeforePoach = countPartyCompanions(world);
            knockOutTeams(world, target.teamIds);
            studioWiped = true;
          }
          return false;
        }
        framesAfterWipe += 1;
        if (world.state === 'loadout') sawPause = true;
        if (sawPause && world.state === 'playing' && partyAfterPoach === 0) {
          partyAfterPoach = countPartyCompanions(world);
        }
        return false;
      },
      onFinish: (world) => {
        finalState = world.state;
        pendingOfferAtEnd = world.floorExtendedState?.floor3PoachOffer !== undefined;
        if (partyAfterPoach === 0) partyAfterPoach = countPartyCompanions(world);
      },
    });

    expect(studioWiped).toBe(true);
    expect(framesAfterWipe).toBeGreaterThan(0);
    // The runner resolved the pause rather than leaving the floor frozen: the
    // world is back in a simulating state and no offer is left dangling.
    expect(finalState).not.toBe('loadout');
    expect(pendingOfferAtEnd).toBe(false);
    // ...and the pick actually recruited the poached Companion.
    expect(partyAfterPoach).toBe(partyBeforePoach + 1);
  });

  it('runs four ordered Final Four rounds and deterministically keeps one Companion', async () => {
    const observedHandlerOrder: string[] = [];
    let lastWipedRound = -1;
    let finalRoundIndex = -1;
    let keptCompanionEid: number | undefined;
    let victoryLatched = false;
    let selectedHandlerOrder: string[] = [];

    const stats = await runHeadless(new BehaviorTreeAI({ seed: 3539 }), {
      seed: 3539,
      floorId: 'floor3',
      maxFrames: 300,
      questStallFrames: 0,
      startPlayerLevel: 20,
      stopWhen: (world) => {
        const state = world.floorExtendedState?.floor3Studios;
        if (!state) return false;

        // Deterministic combat stand-in: clear every spawned Studio roster.
        for (const studio of state.studios) {
          if (studio.unlocked && !studio.defeated) knockOutTeams(world, studio.teamIds);
        }

        // Clear each Final Four roster once, only after the production tick has
        // advanced and spawned that round.
        const round = state.finalFourRounds[state.finalFourRoundIndex];
        if (
          round &&
          state.finalFour.unlocked &&
          state.finalFourRoundIndex !== lastWipedRound &&
          countCompanionsOnTeams(world, state.finalFour.teamIds) > 0
        ) {
          observedHandlerOrder.push(round.handlerId);
          lastWipedRound = state.finalFourRoundIndex;
          knockOutTeams(world, state.finalFour.teamIds);
        }
        return false;
      },
      onFinish: (world) => {
        const state = world.floorExtendedState?.floor3Studios;
        finalRoundIndex = state?.finalFourRoundIndex ?? -1;
        keptCompanionEid = state?.keptCompanionEid;
        selectedHandlerOrder = state?.finalFourRounds.map((round) => round.handlerId) ?? [];
        victoryLatched = world.goalFlags.get('floor3-victory') === true;
      },
    });

    expect(observedHandlerOrder).toHaveLength(4);
    expect(observedHandlerOrder).toEqual(selectedHandlerOrder);
    expect(finalRoundIndex).toBe(4);
    expect(victoryLatched).toBe(true);
    expect(keptCompanionEid).toBeDefined();
    expect(stats.outcome).toBe('victory');
    expect(stats.floor3Progression?.studioVictories).toSatisfy(
      (victories) =>
        victories !== undefined && Object.values(victories).every((victory) => victory !== null),
    );
    expect(stats.floor3Progression?.finalFourRounds.map((round) => round.handlerId)).toEqual(
      selectedHandlerOrder,
    );
    expect(stats.floor3Progression?.finalFourRounds.every((round) => round.victory !== null)).toBe(
      true,
    );
    expect(stats.floor3Progression?.keptCompanionSelected).not.toBeNull();
  });
});
