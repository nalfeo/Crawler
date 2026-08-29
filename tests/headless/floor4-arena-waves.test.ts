import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, Enemy, Health, Player, Team } from '../../src/core/components.js';
import type { GameWorld } from '../../src/core/world.js';
import { GAME, TeamId } from '../../src/shared/constants.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import type { InputState } from '../../src/shared/input.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { capturePlayerCarryover } from '../../src/game/playerCarryover.js';
import { buildKeptCompanionContract } from '../../src/shared/data/floor3/kept-companion-contract.js';
import { getPetSpecies } from '../../src/shared/data/floor3/species.js';
import { isEnemyCombatEligible } from '../../src/game/floor2BossEligibility.js';
import { getCompanionAIDecision } from '../../src/game/systems/companionAISystem.js';

/**
 * A contestant with no plan: it never picks a target or a destination, so the
 * run observes the wave window itself rather than a competent clear. (The
 * runner's baseline reflexes still land occasional hits, so a handful of real
 * kills happen — those are rewarded normally, unlike the cut.)
 */
class IdleFloor4Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor4 wave observation',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

class OvertimeFloor4Provider extends IdleFloor4Provider {
  override poll(input: InputState, world: GameWorld): void {
    super.poll(input, world);
    const playerEid = query(world.ecs, [Player, Health])[0];
    if (playerEid !== undefined) {
      world.stores.health.current[playerEid] = 1_000_000;
    }
    const bossEid = world.floorExtendedState?.floor4Arena?.activeHeadliner?.bossEid;
    if (bossEid !== null && bossEid !== undefined) {
      world.stores.health.current[bossEid] = 1_000_000;
    }
  }
}

class DefeatHeadlinerFloor4Provider extends IdleFloor4Provider {
  override poll(input: InputState, world: GameWorld): void {
    super.poll(input, world);
    const bossEid = world.floorExtendedState?.floor4Arena?.activeHeadliner?.bossEid;
    if (bossEid !== null && bossEid !== undefined) {
      world.stores.health.current[bossEid] = 0;
    }
  }
}

class ObserveCoStarFloor4Provider extends IdleFloor4Provider {
  coStarSamples = 0;
  maxCombatEligibleEnemies = 0;
  sawCoStarExcludedFromHostiles = false;
  sawCoStarRivalTarget = false;

  override poll(input: InputState, world: GameWorld): void {
    super.poll(input, world);
    const playerEid = query(world.ecs, [Player, Health])[0];
    if (playerEid !== undefined) {
      world.stores.health.current[playerEid] = 1_000_000;
    }
    const coStars = query(world.ecs, [Enemy, Companion, Team]).filter(
      (eid) => world.stores.team.id[eid] === TeamId.PLAYER,
    );
    this.coStarSamples += coStars.length;
    this.maxCombatEligibleEnemies = Math.max(
      this.maxCombatEligibleEnemies,
      query(world.ecs, [Enemy]).filter((eid) => isEnemyCombatEligible(world, eid)).length,
    );
    for (const coStar of coStars) {
      if (!isEnemyCombatEligible(world, coStar)) {
        this.sawCoStarExcludedFromHostiles = true;
      }
      const decision = getCompanionAIDecision(world, coStar);
      if (decision?.kind === 'rival-primary' && decision.targetEid !== undefined) {
        this.sawCoStarRivalTarget = true;
      }
    }
  }
}

function floor4CarryoverWithKeptCompanion(seed: number) {
  const source = createTestWorld({ seed });
  const sourcePlayer = spawnPlayer(source, 0, 0);
  const species = getPetSpecies('ember-slinger');
  if (!species) {
    throw new Error('missing ember-slinger test species');
  }
  return {
    ...capturePlayerCarryover(source, sourcePlayer),
    keptCompanion: buildKeptCompanionContract(species),
  };
}

describe('Floor 4 wave window (real headless pipeline)', () => {
  const floor4Phase = getFloorManifest('floor4')!.floor4!.phase;
  const floor4Waves = getFloorManifest('floor4')!.floor4!.waves;
  // Countdown + the whole act-1 wave window + a beat of the headline window, so
  // the run observes every act-1 release AND the cut at the window boundary.
  const horizonMs = floor4Phase.countdownMs + floor4Phase.waveWindowMs + 3_000;

  const run = () =>
    runHeadless(new IdleFloor4Provider(), {
      floorId: 'floor4',
      seed: 404,
      maxFrames: Math.ceil(horizonMs / GAME.DELTA_MS),
    });

  it('releases every act-1 wave and cuts the survivors at the window boundary', async () => {
    const first = await run();
    const telemetry = first.floor4Arena?.waveTelemetry;

    // The window ran to its boundary and handed off to the headline window.
    expect(first.floor4Arena?.phase).toEqual({ kind: 'HEADLINE', act: 1, cleared: false });
    expect(telemetry?.wavesReleased).toBe(floor4Waves.cadence.wavesPerAct);
    expect(telemetry?.enemiesSpawned).toBeGreaterThan(0);
    expect(telemetry?.gateTelegraphsArmed).toBeGreaterThanOrEqual(floor4Waves.cadence.wavesPerAct);

    // The cut fired, and it is disjoint from the normal death path: every
    // spawned enemy is either a real (rewarded) kill or a cut, never both.
    // That the cut itself pays nothing is proven exactly in
    // tests/unit/floor4-arena-waves.test.ts, where kills are held at zero.
    expect(telemetry?.enemiesCut).toBeGreaterThan(0);
    expect(first.combat.totalKills + (telemetry?.enemiesCut ?? 0)).toBeLessThanOrEqual(
      telemetry?.enemiesSpawned ?? 0,
    );
    // If the 20-odd cut enemies had paid out, XP would scale with everything
    // spawned rather than with the handful actually killed.
    expect(first.totalXp - (first.runStartXp ?? 0)).toBeLessThan(telemetry?.enemiesSpawned ?? 0);
  });

  it('is deterministic across two runs of the same seed', async () => {
    const first = await run();
    const second = await run();

    expect(first.floor4Arena?.waveTelemetry).toEqual(second.floor4Arena?.waveTelemetry);
    expect(first.floor4Arena?.timeline).toEqual(second.floor4Arena?.timeline);
    expect(first.floor4Arena?.arenaElapsedMs).toBe(second.floor4Arena?.arenaElapsedMs);
    expect(first.outcome).toBe(second.outcome);
    // Retained from the slice-2 empty-arena run: the countdown is safe-room time,
    // so it never burns the collapse-relevant active-time budget (FR8.4).
    expect(first.safeRoomMs).toBeGreaterThanOrEqual(floor4Phase.countdownMs);
    expect(first.safeRoomMs).toBe(second.safeRoomMs);
  });

  it('re-hosts a kept companion through the real headless Floor 4 pipeline', async () => {
    const provider = new ObserveCoStarFloor4Provider();
    const result = await runHeadless(provider, {
      floorId: 'floor4',
      seed: 404,
      playerCarryover: floor4CarryoverWithKeptCompanion(404),
      maxFrames: Math.ceil(horizonMs / GAME.DELTA_MS),
    });

    expect(provider.coStarSamples).toBeGreaterThan(0);
    expect(provider.maxCombatEligibleEnemies).toBeGreaterThan(0);
    expect(provider.sawCoStarExcludedFromHostiles).toBe(true);
    expect(provider.sawCoStarRivalTarget).toBe(true);
    expect(result.floor4Arena?.waveTelemetry).toMatchObject({
      wavesReleased: floor4Waves.cadence.wavesPerAct,
      enemiesSpawned: expect.any(Number),
    });
  });

  it('resolves a defeated Headliner reward through the canonical headless pipeline', async () => {
    const horizonMs =
      floor4Phase.countdownMs +
      floor4Phase.waveWindowMs +
      floor4Phase.headlineWindowMs +
      floor4Phase.intermissionMs;
    const result = await runHeadless(new DefeatHeadlinerFloor4Provider(), {
      floorId: 'floor4',
      seed: 404,
      maxFrames: Math.ceil(horizonMs / GAME.DELTA_MS) + 4,
    });

    expect(result.floor4Arena?.headlinerTelemetry).toMatchObject({
      spawned: 1,
      defeated: 1,
      chestsSpawned: 1,
      chestsForceResolved: 1,
    });
    expect(result.totalGold).toBeGreaterThan(0);
  });

  it('resolves the overtime finisher through the canonical headless pipeline', async () => {
    const horizonMs =
      floor4Phase.countdownMs +
      floor4Phase.waveWindowMs +
      floor4Phase.headlineWindowMs +
      floor4Phase.overtimeCapMs;
    const result = await runHeadless(new OvertimeFloor4Provider(), {
      floorId: 'floor4',
      seed: 404,
      // Each phase transition starts the next phase on the following frame, so
      // account for the discarded fractional frame at every boundary.
      maxFrames: Math.ceil(horizonMs / GAME.DELTA_MS) + 4,
    });

    expect(result.floor4Arena?.phase).toEqual({ kind: 'DEFEAT' });
    expect(result.outcome).toBe('death');
  });
});
