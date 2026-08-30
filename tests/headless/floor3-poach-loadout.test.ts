import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, PartySlot, Team } from '../../src/core/index.js';
import type { GameWorld } from '../../src/core/world.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
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
  });
});
