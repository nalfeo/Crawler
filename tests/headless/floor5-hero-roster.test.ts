import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import type { GameWorld } from '../../src/core/world.js';
import { Health, SiegeHero, Team } from '../../src/core/components.js';
import { TeamId } from '../../src/shared/constants.js';
import { applyDamage } from '../../src/core/index.js';
import type { InputState } from '../../src/shared/input.js';
import type { Floor5SiegeState } from '../../src/shared/floor-types.js';
import { getFloor5SiegeRunStats } from '../../src/game/floor5Scenario.js';
import { FLOOR5_FIELD_HERO_ROSTER } from '../../src/shared/floor5-heroes.js';
import floor5Manifest from '../../src/shared/data/floors/floor5.manifest.json' with { type: 'json' };

const HERO_CONFIG = floor5Manifest.floor5.heroes;

class IdleFloor5Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor5 field-hero observation',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

/**
 * Install deterministic per-frame probes around the floor's own objective tick
 * — the documented Floor 5 damage-authority seam.
 *
 * `before` runs BEFORE the objective tick, which is where injected damage has
 * to land: `resolveFloor5HeroDefeat` is post-damage defeat authority, so a
 * killing blow dealt after it has already run this frame would only be booked
 * on the NEXT frame and the killing-blow-frame contract would go unverified.
 * `after` observes the bookkeeping the same tick wrote it.
 *
 * `stopWhen` is used only as the once-per-frame installation trigger.
 */
function withTickProbe(probes: {
  before?: (world: GameWorld) => void;
  after?: (world: GameWorld) => void;
}): (world: GameWorld) => boolean {
  let installed = false;
  return (world: GameWorld) => {
    if (!installed) {
      installed = true;
      const inner = world.floorObjectiveTick;
      world.floorObjectiveTick = (w: GameWorld) => {
        probes.before?.(w);
        inner?.(w);
        probes.after?.(w);
      };
    }
    return false;
  };
}

function siegeState(world: GameWorld): Floor5SiegeState {
  const state = world.floorExtendedState?.floor5Siege;
  if (!state) throw new Error('floor5 siege state missing');
  return state;
}

/** Kill the live Hero through the same damage path every other actor uses. */
function executeActiveHero(world: GameWorld): void {
  const state = siegeState(world);
  const eid = state.heroes.eid;
  if (eid <= 0) return;
  applyDamage(
    world,
    eid,
    (world.stores.health.current[eid] ?? 0) + 1,
    world.stores.position.x[eid] ?? 0,
    world.stores.position.y[eid] ?? 0,
    { origin: 'environment', affinity: 'physical', scaleWithPrimary: false, canCrit: false },
  );
}

describe('Floor 5 field Heroes in the real headless pipeline', () => {
  it('fields exactly one Hero at the manifest-authored frame, from the seeded draw', async () => {
    let heroTeams: number[] = [];
    let heroCountAtEnd = 0;
    const stats = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 900,
      questStallFrames: 0,
      onFinish: (world) => {
        const live = Array.from(query(world.ecs, [SiegeHero, Health, Team])).filter(
          (eid) => (world.stores.health.current[eid] ?? 0) > 0,
        );
        heroCountAtEnd = live.length;
        heroTeams = live.map((eid) => world.stores.team.id[eid] ?? -1);
      },
    });

    const heroes = stats.floor5Siege!.heroes;
    // HUMAN_GATE-3: one active field Hero at a time, never a pack.
    expect(heroCountAtEnd).toBe(1);
    expect(heroTeams).toEqual([TeamId.SIEGE_ENEMY]);
    expect(heroes.status).toBe('active');
    expect(heroes.cursor).toBe(0);
    expect(heroes.spawns).toBe(1);
    expect(heroes.spawnedFrame).toBe(HERO_CONFIG.firstSpawnFrame);
    expect(heroes.fieldedHeroIds).toEqual([heroes.card[0]!.heroId]);
    expect(heroes.activeHeroId).toBe(heroes.card[0]!.heroId);
    expect(stats.floor5Siege!.heroState).toBe(`ACTIVE:${heroes.card[0]!.heroId}`);
  });

  it('draws the same Hero card for the same seed and a different one for another seed', async () => {
    const cardFor = async (seed: number): Promise<string[]> => {
      const stats = await runHeadless(new IdleFloor5Provider(), {
        floorId: 'floor5',
        seed,
        maxFrames: 240,
        questStallFrames: 0,
      });
      return stats.floor5Siege!.heroes.card.map((entry) => entry.heroId);
    };

    const [runA, runB, other] = await Promise.all([cardFor(505), cardFor(505), cardFor(77)]);
    expect(runB).toEqual(runA);
    expect(runA).toHaveLength(FLOOR5_FIELD_HERO_ROSTER.length);
    expect(new Set(runA).size).toBe(FLOOR5_FIELD_HERO_ROSTER.length);
    expect(other).not.toEqual(runA);
  });

  it("holds the Hero within its declared role's leash instead of chasing the lane", async () => {
    let anchorDistanceFt = Number.POSITIVE_INFINITY;
    let observedRole = '';
    await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 900,
      questStallFrames: 0,
      onFinish: (world) => {
        const state = siegeState(world);
        const eid = state.heroes.eid;
        const card = state.heroes.card[state.heroes.cursor]!;
        observedRole = card.role;
        anchorDistanceFt = Math.hypot(
          (world.stores.position.x[eid] ?? 0) - (world.stores.siegeHero.anchorX[eid] ?? 0),
          (world.stores.position.y[eid] ?? 0) - (world.stores.siegeHero.anchorY[eid] ?? 0),
        );
      },
    });

    const roster = FLOOR5_FIELD_HERO_ROSTER.find((entry) => entry.role === observedRole)!;
    // FR6.2: a Hero's declared role is its sole strategic mode, so it never
    // wanders beyond the leash its role grants it.
    expect(anchorDistanceFt).toBeLessThanOrEqual(roster.leashRadiusFt);
  });

  it('respawns the next Hero on the card at exactly the manifest-authored offset', async () => {
    let defeatFrame = -1;
    let killingBlowFrame = -1;
    let respawnScheduledFor = -1;
    let statusAfterDefeat = '';
    let killed = false;
    let secondHeroId = '';
    let spawnedFrameAfterRespawn = -1;
    let cursorAfterRespawn = -1;
    let cardIds: string[] = [];

    await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 1_200,
      questStallFrames: 0,
      stopWhen: withTickProbe({
        // Damage lands BEFORE the objective tick, exactly like real siege
        // damage, so the frame recorded below is genuinely the killing-blow
        // frame and not the frame after it.
        before: (world) => {
          const heroes = siegeState(world).heroes;
          if (heroes.status === 'active' && heroes.cursor === 0 && !killed) {
            killed = true;
            killingBlowFrame = world.frameCount;
            executeActiveHero(world);
          }
        },
        // Capture the defeat bookkeeping on the frame it is written, before the
        // respawn clears it.
        after: (world) => {
          const heroes = siegeState(world).heroes;
          if (killed && heroes.status === 'down' && defeatFrame < 0) {
            defeatFrame = heroes.defeatedFrame ?? -1;
            respawnScheduledFor = heroes.respawnFrame ?? -1;
            statusAfterDefeat = heroes.status;
          }
        },
      }),
      onFinish: (world) => {
        const heroes = siegeState(world).heroes;
        cardIds = heroes.card.map((entry) => entry.heroId);
        cursorAfterRespawn = heroes.cursor;
        secondHeroId = heroes.fieldedHeroIds[1] ?? '';
        spawnedFrameAfterRespawn = heroes.spawnedFrame ?? -1;
      },
    });

    expect(defeatFrame).toBeGreaterThan(0);
    // FR6.4: the recorded defeat frame IS the frame of the killing blow.
    expect(killingBlowFrame).toBeGreaterThan(0);
    expect(defeatFrame).toBe(killingBlowFrame);
    expect(cursorAfterRespawn).toBe(1);
    expect(secondHeroId).toBe(cardIds[1]);
    // FR6.4: respawn is a FIXED frame offset from defeat — no wall clock, no RNG.
    expect(statusAfterDefeat).toBe('down');
    expect(respawnScheduledFor).toBe(defeatFrame + HERO_CONFIG.respawnDelayFrames);
    expect(spawnedFrameAfterRespawn).toBe(defeatFrame + HERO_CONFIG.respawnDelayFrames);
  });

  it('retires the slot permanently once the without-replacement card is exhausted', async () => {
    let status = '';
    let respawnFrame: number | null = -1;
    let fielded: string[] = [];
    let cardIds: string[] = [];
    let liveHeroes = -1;

    await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      // Long enough to burn the whole 8-entry card at the authored cadence.
      maxFrames: 4_000,
      questStallFrames: 0,
      stopWhen: withTickProbe({
        before: (world) => {
          if (siegeState(world).heroes.status === 'active') {
            executeActiveHero(world);
          }
        },
      }),
      onFinish: (world) => {
        const heroes = siegeState(world).heroes;
        status = heroes.status;
        respawnFrame = heroes.respawnFrame;
        fielded = [...heroes.fieldedHeroIds];
        cardIds = heroes.card.map((entry) => entry.heroId);
        liveHeroes = Array.from(query(world.ecs, [SiegeHero, Health])).filter(
          (eid) => (world.stores.health.current[eid] ?? 0) > 0,
        ).length;
      },
    });

    // The draw does NOT cycle: every Hero is fielded once, in card order, and
    // then the slot stays empty for the rest of the run (FR6.4 "remain
    // defeated according to their slot").
    expect(fielded).toEqual(cardIds);
    expect(status).toBe('retired');
    expect(respawnFrame).toBeNull();
    expect(liveHeroes).toBe(0);
  });
});

describe('Floor 5 engine-disruption Heroes', () => {
  it('anchors on the command-post build site rather than the lane once construction is live', async () => {
    // Deterministic role probe: drive the card forward until the engine-
    // disruption Hero is the one on the field, then observe where it holds.
    let observed: {
      role: string;
      anchorToBuildSiteFt: number;
      engineEngaged: boolean;
    } | null = null;

    await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 4_000,
      questStallFrames: 0,
      stopWhen: withTickProbe({
        before: (world) => {
          const state = siegeState(world);
          const heroes = state.heroes;
          if (heroes.status !== 'active' || heroes.eid <= 0) return;
          const card = heroes.card[heroes.cursor]!;
          // Mirrors production's `floor5EngineEngaged` latch exactly.
          const engineEngaged =
            state.phase.kind === 'BUILD' ||
            state.phase.kind === 'ESCORT' ||
            state.engineState === 'BUILDING' ||
            state.engineState === 'READY' ||
            state.engineState === 'ADVANCING' ||
            state.engineState === 'ATTACKING';
          if (card.role === 'engine-disruption' && engineEngaged) {
            const site = state.structures['command-post'];
            if (observed === null && site.eid > 0) {
              observed = {
                role: card.role,
                engineEngaged,
                // FR6.2/FR6.3: the role's ONE anchor rule is the build site, so
                // measure the stored anchor against the command post itself —
                // measuring the Hero against its own anchor would pass even if
                // the Hero stayed anchored to the lane.
                anchorToBuildSiteFt: Math.hypot(
                  (world.stores.siegeHero.anchorX[heroes.eid] ?? 0) -
                    (world.stores.position.x[site.eid] ?? 0),
                  (world.stores.siegeHero.anchorY[heroes.eid] ?? 0) -
                    (world.stores.position.y[site.eid] ?? 0),
                ),
              };
            }
            return;
          }
          // Not the role under test yet — advance the card.
          executeActiveHero(world);
        },
      }),
    });

    expect(observed).not.toBeNull();
    expect(observed!.role).toBe('engine-disruption');
    expect(observed!.engineEngaged).toBe(true);
    expect(observed!.anchorToBuildSiteFt).toBe(0);
  });
});

describe('Floor 5 Hero telegraphed abilities in the real pipeline', () => {
  it('drives a registered Hero all the way to ability resolution', async () => {
    const stats = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      // Hero takes the field at frame 600, is first eligible 4,000ms later and
      // resolves after a 1,200ms telegraph (~frame 912 at the fixed step).
      maxFrames: 1_200,
      questStallFrames: 0,
    });

    // The shared mob-ability runtime is the ONLY ability path on this floor, so
    // a non-zero cast count is proof the Hero reached resolution through it.
    expect(stats.floor5Siege!.heroes.abilityCasts).toBeGreaterThan(0);
  });
});

describe('getFloor5SiegeRunStats hero projection', () => {
  it('reports no active Hero before the slot opens', async () => {
    await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 120,
      questStallFrames: 0,
      onFinish: (world) => {
        const stats = getFloor5SiegeRunStats(world)!;
        expect(stats.heroes.status).toBe('pending');
        expect(stats.heroes.activeHeroId).toBeNull();
        expect(stats.heroes.activeRole).toBeNull();
        expect(stats.heroes.spawns).toBe(0);
        expect(stats.heroState).toBe('PENDING');
        expect(query(world.ecs, [SiegeHero]).length).toBe(0);
      },
    });
  });
});
